const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    app: "Canta con el corazón",
    musicApiConfigured: Boolean(
      process.env.MUSIC_API_BASE_URL &&
      process.env.MUSIC_API_KEY &&
      process.env.MUSIC_API_GENERATE_PATH
    )
  });
});

// The API key stays on the server. Never place it in public/index.html.
app.post("/api/songs/generate", async (req, res) => {
  const { MUSIC_API_BASE_URL, MUSIC_API_KEY, MUSIC_API_GENERATE_PATH } = process.env;

  if (!MUSIC_API_BASE_URL || !MUSIC_API_KEY || !MUSIC_API_GENERATE_PATH) {
    return res.status(503).json({
      ok: false,
      code: "MUSIC_API_NOT_CONFIGURED",
      message: "La creación de canciones se activará cuando configuremos la API musical."
    });
  }

  const { lyrics, genre, title } = req.body || {};
  if (!lyrics || !genre) {
    return res.status(400).json({
      ok: false,
      message: "Faltan la letra o el género musical."
    });
  }

  try {
    const endpoint = new URL(MUSIC_API_GENERATE_PATH, MUSIC_API_BASE_URL).toString();
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MUSIC_API_KEY}`
      },
      body: JSON.stringify({ title: title || "Canta con el corazón", lyrics, genre })
    });

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        message: "El proveedor musical rechazó la solicitud.",
        providerStatus: upstream.status
      });
    }

    // The provider's response format may differ. We will map its job ID/audio URL
    // after the user chooses and supplies the actual API documentation.
    return res.json({ ok: true, providerResponse: data });
  } catch (error) {
    console.error("Music API error:", error.message);
    return res.status(502).json({
      ok: false,
      message: "No se pudo conectar con el servicio musical."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Canta con el corazón running on ${PORT}`));
