import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 10000;

app.disable("x-powered-by");
app.use(express.static(__dirname, { extensions: ["html"] }));
app.get("/health", (_req, res) => res.json({ ok: true, mode: "whatsapp-manual", storage: "not-required" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(port, "0.0.0.0", () => {
  console.log("Canta con el corazón listo en el puerto " + port + " (pedidos por WhatsApp; sin Supabase).");
});
