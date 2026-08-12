import { config } from "../config.js";
import { sendSongWithKanwap } from "./kanwapService.js";
import { sendSongWithVevWhatsapp } from "./vevWhatsappService.js";

export async function sendSongWithWhatsapp(song) {
  if (config.whatsappProvider === "vev") {
    return sendSongWithVevWhatsapp(song);
  }

  return sendSongWithKanwap(song);
}
