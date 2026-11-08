import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const { Pool } = pg;
const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||10000;
app.use(express.json({limit:"3mb"}));
app.use(express.static(path.join(__dirname,"public")));
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes("render.com")?{rejectUnauthorized:false}:undefined}):null;
async function initDb(){if(!pool)return;await pool.query(`CREATE TABLE IF NOT EXISTS orders(id BIGSERIAL PRIMARY KEY, customer_name TEXT NOT NULL, email TEXT, phone TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, status TEXT NOT NULL DEFAULT 'nuevo', payment_status TEXT NOT NULL DEFAULT 'pendiente', voucher_data TEXT, preview_url TEXT, full_song_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);}
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"canta-corazon-nueva-tienda",database:Boolean(pool)}));
app.get("/api/config",(_req,res)=>res.json({brand:"Canta con el Corazón",currency:"PEN",price:30,previewSeconds:30,yapeQrConfigured:Boolean(process.env.YAPE_QR_IMAGE_URL),trebloConfigured:Boolean(process.env.TREBLO_API_KEY),database:Boolean(pool)}));
app.post("/api/orders",async(req,res)=>{if(!pool)return res.status(503).json({error:"Los pedidos se habilitarán al conectar la base de datos."});const d=req.body||{};const name=String(d.sender||"").trim();if(!name)return res.status(400).json({error:"Falta el nombre del remitente."});try{const {rows}=await pool.query("INSERT INTO orders(customer_name,email,phone,details) VALUES($1,$2,$3,$4) RETURNING id,created_at,status,payment_status",[name,d.email||null,d.phone||null,d]);res.status(201).json({order:rows[0]});}catch(e){res.status(500).json({error:"No se pudo registrar el pedido."});}});
app.get("*",(req,res,next)=>{if(req.path.startsWith("/api/"))return res.status(404).json({error:"Ruta no encontrada."});next();});
initDb().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log("Nueva tienda escuchando en",PORT))).catch(e=>{console.error("Error iniciando base de datos",e);process.exit(1);});
