import fs from "node:fs";
import path from "node:path";
import axios from "axios";

export async function downloadToFile(url, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const response = await axios.get(url, { responseType: "stream" });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destinationPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
    response.data.on("error", reject);
  });
}
