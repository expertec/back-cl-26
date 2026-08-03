import fs from "node:fs";
import axios from "axios";

export async function downloadToFile(url, destinationPath) {
  const response = await axios.get(url, { responseType: "stream" });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destinationPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}
