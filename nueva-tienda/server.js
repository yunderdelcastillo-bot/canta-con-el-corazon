import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||10000;
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"canta-corazon-nueva-tienda"}));
app.get("/api/config",(_req,res)=>res.json({
 brand:"Canta con el Corazón",
 currency:"PEN",
 price:Number(process.env.SONG_PRICE||20),
 previewSeconds:Number(process.env.PREVIEW_SECONDS||30),
 yapeQrConfigured:Boolean(process.env.YAPE_QR_IMAGE_URL),
 trebloConfigured:Boolean(process.env.TREBLO_API_KEY)
}));
app.post("/api/orders",(_req,res)=>res.status(501).json({error:"La creación real de pedidos se habilitará al conectar Treblo y la base de datos segura."}));
app.listen(PORT,"0.0.0.0",()=>console.log("Canta con el Corazón nueva tienda en puerto",PORT));