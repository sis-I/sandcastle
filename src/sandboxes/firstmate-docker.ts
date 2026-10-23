/**
 * Firstmate Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider
 * for Firstmate crewmate agents.
 *
 * The crewmate agent (pi/opencode) runs inside a Docker container. Firstmate
 * captain, Herdr server, and Treehouse stay on the host. The provider
 * bind-mounts the pre-acquired Treehouse worktree into the container and
 * injects Firstmate metadata as environment variables.
 *
 * Usage:
 *   import { firstmateDocker } from "sandcastle/sandboxes/firstmate-docker";
 *   await run({ agent: pi("claude-opus-4-8"), sandbox: firstmateDocker() });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { startContainer, removeContainer } from "../DockerLifecycle.js";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import type { SelinuxLabel } from "../mountUtils.js";
import {
  defaultImageName,
  resolveUserMounts,
  processFileMountParents,
} from "../mountUtils.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";
import { registerShutdown } from "../shutdownRegistry.js";

/** Firstmate-specific environment variables injected into the crewmate container. */
export interface FirstmateDockerOptions {
  /** Docker image name (default: firstmate-crewmate). */
  readonly imageName?: string;
  /** The UID of the `agent` user inside the container image (default: 1000). */
  readonly containerUid?: number;
  /** The GID of the `agent` user inside the container image (default: 1000). */
  readonly containerGid?: number;
  /** SELinux volume label suffix applied to bind mounts ("z" | "Z" | false). */
  readonly selinuxLabel?: SelinuxLabel;
  /** Additional host directories to bind-mount into the sandbox. */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
  /** Maximum number of characters of streamed exec output retained per stream. */
  readonly maxOutputTailChars?: number;
}

/** Create a Firstmate Docker sandbox provider. */
export const firstmateDocker = (
  options?: FirstmateDockerOptions,
): SandboxProvider => {
  const configuredImageName = options?.imageName ?? "firstmate-crewmate";
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, sandboxHomedir)
    : [];
  const parentDirsToCreate = processFileMountParents(
    userMounts,
    sandboxHomedir,
  );

  return createBindMountSandboxProvider({
    name: "firstmateDocker",
    env: options?.env,
    sandboxHomedir,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-firstmate-${randomUUID()}`;

      const worktreePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => ({
        hostPath: m.hostPath,
        sandboxPath: m.sandboxPath,
        readonly: m.readonly,
      }));

      const containerUid = options?.containerUid ?? 1000;
      const containerGid = options?.containerGid ?? 1000;

      // Start container with Firstmate env injected at the Docker level.
      await Effect.runPromise(
        startContainer(
          containerName,
          configuredImageName,
          {
            ...createOptions.env,
            HOME: "/home/agent",
          },
          {
            volumeMounts,
            workdir: worktreePath,
            user: `${containerUid}:${containerGid}`,
            selinuxLabel,
          },
        ),
      );

      // Create parent directories for file mounts and chown to the container user
      for (const dir of parentDirsToCreate) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "docker",
            [
              "exec",
              "--user",
              "0:0",
              containerName,
              "sh",
              "-c",
              `mkdir -p "$1" && chown "$2" "$1"`,
              "sh",
              dir,
              `${containerUid}:${containerGid}`,
            ],
            (error) => {
              if (error) {
                reject(
                  new Error(
                    `Failed to create parent directory '${dir}' in container: ${error.message}`,
                  ),
                );
              } else {
                resolve();
              }
            },
          );
        });
      }

      const removeContainerSync = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      const handle: BindMountSandboxHandle = {
        worktreePath,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("docker", args, {
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });

            if (opts?.stdin !== undefined) {
              proc.stdin!.write(opts.stdin);
              proc.stdin!.end();
            }

            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            if (opts?.onLine) {
              const onLine = opts.onLine;
              const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
              const stderrTail = new BoundedTail(maxOutputTailChars, "");
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutTail.push(line);
                onLine(line);
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrTail.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutTail.toString(),
                  stderr: stderrTail.toString(),
                  exitCode: code ?? 0,
                });
              });
            } else {
              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              proc.stdout!.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join(""),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            }
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            const dockerArgs = ["exec"];
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              dockerArgs.push("-it");
            } else {
              dockerArgs.push("-i");
            }
            if (opts.cwd) dockerArgs.push("-w", opts.cwd);
            dockerArgs.push(containerName, ...args);

            const proc = spawn("docker", dockerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },

        copyFileIn: (hostPath: string, sandboxPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (in) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (out) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        close: async (): Promise<void> => {
          unregisterShutdown();
          await Effect.runPromise(removeContainer(containerName));
        },
      };

      return handle;
    },
  });
};

// Re-export for convenience
export { defaultImageName };
