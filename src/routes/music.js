import { Router } from "express";
import { db, FieldValue } from "../firebase.js";
import { musicRequestSchema, normalizePhone } from "../schemas.js";
import { runMusicPipeline } from "../jobs/musicPipeline.js";

export const musicRouter = Router();

musicRouter.post("/request", async (req, res) => {
  const parsed = musicRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Datos invalidos.",
      issues: parsed.error.flatten().fieldErrors
    });
  }

  try {
    const data = parsed.data;
    const docRef = await db.collection("musica").add({
      ...data,
      leadPhone: normalizePhone(data.phone),
      status: "Sin letra",
      deliveryProvider: "kanwap",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    console.log("[music/request] created", {
      musicId: docRef.id,
      phone: normalizePhone(data.phone),
      title: data.title
    });

    runMusicPipeline().catch((error) => {
      console.error("[music/request] pipeline trigger failed:", error);
    });

    return res.status(201).json({
      ok: true,
      musicId: docRef.id,
      status: "Sin letra"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo crear el pedido."
    });
  }
});

musicRouter.get("/:musicId", async (req, res) => {
  try {
    const snap = await db.collection("musica").doc(req.params.musicId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Pedido no encontrado." });
    }

    return res.json({
      ok: true,
      music: {
        id: snap.id,
        ...snap.data()
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo consultar el pedido."
    });
  }
});
