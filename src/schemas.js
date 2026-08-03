import { z } from "zod";

export const musicRequestSchema = z.object({
  customerName: z.string().min(2).max(120),
  phone: z.string().min(8).max(25),
  recipientName: z.string().min(2).max(120),
  occasion: z.string().min(2).max(120),
  language: z.string().min(2).max(40).default("Espanol"),
  title: z.string().min(2).max(100),
  story: z.string().min(10).max(1000),
  genre: z.string().min(2).max(120),
  referenceArtist: z.string().min(2).max(120).optional().or(z.literal("")),
  voiceType: z.string().min(2).max(120),
  mood: z.string().min(2).max(160),
  sunoModel: z.enum(["V4", "V4_5", "V4_5PLUS", "V4_5ALL", "V5", "V5_5"]).optional(),
  negativeTags: z.string().max(300).optional().or(z.literal("")),
  source: z.string().default("cantalab-next")
});

export function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}
