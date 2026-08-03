import { config } from "../config.js";

export function assertJobAccess(req, res, next) {
  if (!config.jobSecret) return next();

  const token = req.get("x-job-secret") || req.query.secret;
  if (token !== config.jobSecret) {
    return res.status(401).json({ ok: false, error: "No autorizado." });
  }

  return next();
}
