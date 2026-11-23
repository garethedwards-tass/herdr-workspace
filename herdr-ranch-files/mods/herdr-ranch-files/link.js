// Herdr Ranch: Ctrl/Cmd-click on a file path in a terminal opens it in the Files panel; with a
// line ("src/app.js:42", "app.py(42)", "#L42") that line is selected. Folders, binary files
// (images, PDFs, archives) and files on another machine go on to Herdr's usual opener.
import { exec, setShared, run } from "herdr";

export const OPEN_KEY = "files.open"; // { path, line, at }: read by the Files view (main.js)
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|heic|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|pkg|exe|dll|so|dylib|o|a|class|jar|wasm|mp3|mp4|mov|avi|mkv|wav|flac|ogg|woff2?|ttf|otf|eot|sqlite|db)$/i;

// The line a link's text names, or null: path:42, path:42:7, path(42), path(42,7), path#L42.
export function lineOf(raw) {
  const m = /(?::(\d+)(?::\d+)?|\((\d+)(?:,\s*\d+)?\)|#L(\d+)(?:-L?\d+)?)\W*$/.exec(raw ?? "");
  const n = m ? Number(m[1] ?? m[2] ?? m[3]) : 0;
  return n > 0 ? n : null;
}

export const wanted = (link, source) => link?.kind === "file" && Boolean(link.path) && !source?.machine && !BINARY.test(link.path);

export async function handleLink({ link, source }) {
  if (!wanted(link, source)) return "pass";
  const file = await exec("test", ["-f", link.path]).catch(() => null);
  if (file?.code !== 0) return "pass";
  setShared(OPEN_KEY, { path: link.path, line: lineOf(link.raw), at: Date.now() });
  run("layout.select", { stack: "panel-body", child: "files" });
  run("layout.show", { id: "panel" });
  return "handled";
}
