import fs from "node:fs";
import { rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import axios from "axios";

export async function downloadToFile(url, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const partialPath = `${destinationPath}.part`;
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300
  });
  const writer = fs.createWriteStream(partialPath);

  try {
    await pipeline(response.data, writer);
    await rename(partialPath, destinationPath);
  } catch (error) {
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch {
      // ignore cleanup errors
    }
    throw new Error(`No se pudo descargar audio a ${destinationPath}: ${error.message}`);
  }

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
