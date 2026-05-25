import { ipc } from "@/lib/ipc";
import { toast } from "@/components/Toast";

/**
 * Reveal a file or directory in the platform file manager.
 *
 * Previously this just called `shellOpen(path)` from `tauri-plugin-shell`,
 * which *opens* a file with its default app (e.g. launches a code editor on
 * a .ts file) instead of revealing it in Finder. We now delegate to a Rust
 * IPC that runs the correct platform command:
 *   - macOS: `open -R <path>`
 *   - Windows: `explorer.exe /select,<path>`
 *   - Linux: freedesktop FileManager1 D-Bus → falls back to `xdg-open <parent>`
 *
 * If the OS-level command itself fails (file missing, no GUI shell, etc.)
 * we surface a toast so the user isn't left wondering why nothing happened.
 */
export async function revealInFiler(path: string): Promise<void> {
  try {
    await ipc.revealInFiler(path);
  } catch (e) {
    const body = e instanceof Error ? e.message : String(e);
    console.warn("reveal failed", e);
    toast.error("Couldn't reveal in Finder", { body });
  }
}
