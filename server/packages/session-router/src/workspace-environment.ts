/** Host-owned local dependency paths; only WORKSPACE_DIR is persistent. */
export const WORKSPACE_ENV = {
  HOME: "/home/user",
  WORKSPACE_DIR: "/home/user/workspace",
  STORY_SEED_WORKSPACE: "/home/user/workspace",
  MEDIAKIT_OUTPUT_PATH: "/home/user/workspace/media",
  XDG_CACHE_HOME: "/home/user/.cache",
  NPM_CONFIG_CACHE: "/home/user/.cache/npm",
  NPM_CONFIG_PREFIX: "/home/user/.local/npm",
  NODE_PATH: "/home/user/.local/oma-node/node_modules",
  PIP_CACHE_DIR: "/home/user/.cache/pip",
  PYTHONPATH: "/home/user/.local/oma-python",
  TMPDIR: "/tmp",
} as const;

export const WORKSPACE_INSTRUCTIONS = `The persistent Workspace is /home/user/workspace. Relative file paths and commands start there. HOME is /home/user and remains local to this Sandbox. Equipped Skills are read-only under /skills/<skill-name>, outside the Workspace.
Save outputs inside the Workspace and successfully close each file before reporting it saved. Already saved writes survive errors and Interrupt; there is no Turn transaction or rollback. Multiple Sessions may overwrite the same file. Background processes and open handles are not guaranteed saved when a Turn ends; finish and close output files explicitly. Directory visibility may be delayed by OSS mount caches.
Keep dependencies and caches local. Supported Node installation: npm install --prefix "$HOME/.local/oma-node" --no-save <package>. NODE_PATH points to that node_modules directory for CommonJS require; for ESM use createRequire from node:module or import the dependency's absolute local path. Do not expect NODE_PATH to change native ESM resolution.
Supported Python installation: python3 -m pip install --target "$PYTHONPATH" <package>. PYTHONPATH points outside the Workspace, so python3 can import the installed package. Use python3 -m venv "$HOME/.local/venvs/<name>" for an isolated local environment. Reinstall local dependencies after Sandbox rebuilds.
These are supported install conventions, not shell interception: npm install or venv creation inside the Workspace can persist node_modules or .venv. Avoid doing that. .oma-workspace-checks is reserved for mount health checks.`;
