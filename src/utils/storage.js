import { bucket } from "../firebase.js";

export async function uploadAudioAndGetUrl(localPath, destination, contentType) {
  const [file] = await bucket.upload(localPath, {
    destination,
    metadata: { contentType }
  });

  try {
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${file.name}`;
  } catch {
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: "03-01-2500"
    });
    return url;
  }
}
