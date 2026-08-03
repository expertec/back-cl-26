import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import axios from "axios";

export async function downloadToFile(url, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const response = await axios.get(url, { responseType: "stream" });
  const writer = fs.createWriteStream(destinationPath);

  await pipeline(response.data, writer);

  const stats = fs.statSync(destinationPath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Descarga vacia o invalida: ${destinationPath}`);
  }

  console.log("[download] saved", {
    path: destinationPath,
    bytes: stats.size,
    contentType: response.headers["content-type"] || null
  });
}
