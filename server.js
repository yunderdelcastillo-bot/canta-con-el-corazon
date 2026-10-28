import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const app=express();
app.use(express.json({limit:"1mb"}));
const allowed=(process.env.ALLOWED_ORIGINS||"https://canta-con-el-corazon.onrender.com").split(",").map(s=>s.trim());
app.use(cors({origin(origin,cb){if(!origin||allowed.includes(origin))return cb(null,true);cb(new Error("Origin not allowed"));}}));
const port=process.env.PORT||10000;
const url=process.env.SUPABASE_URL;
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey=process.env.SUPABASE_ANON_KEY;
const ready=()=>Boolean(url&&serviceKey&&anonKey);
const admin=()=>createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
app.get("/health",(req,res)=>res.json({ok:true,configured:ready(),storage:"private-signed-urls"}));
app.get("/api/audio",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Storage privado aún no está configurado en el servidor."});
  const path=String(req.query.path||"");
  if(!/^[0-9a-f-]{36}\\/[0-9a-f-]{36}\\.mp3$/i.test(path))return res.status(400).json({error:"Ruta de audio no válida."});
  const db=admin();
  const {data:song,error}=await db.from("songs").select("id,published,audio_path,owner_id").eq("audio_path",path).maybeSingle();
  if(error||!song)return res.status(404).json({error:"Canción no encontrada."});
  const grant=String(req.query.grant||"");
  if(!song.published){
   if(!grant)return res.status(403).json({error:"Canción no publicada."});
   const {data:g}=await db.from("download_grants").select("id,song_id,expires_at").eq("token_hash",crypto.createHash("sha256").update(grant).digest("hex")).eq("song_id",song.id).gt("expires_at",new Date().toISOString()).maybeSingle();
   if(!g)return res.status(403).json({error:"Autorización inválida o vencida."});
  }
  const {data,error:signError}=await db.storage.from("songs-audio").createSignedUrl(path,300);
  if(signError||!data?.signedUrl)return res.status(500).json({error:"No se pudo crear el enlace temporal."});
  res.set("Cache-Control","no-store").redirect(302,data.signedUrl);
 }catch(e){res.status(500).json({error:"Error interno al preparar el audio."});}
});
app.get("/api/verify-grant",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({valid:false,error:"Storage privado aún no está configurado."});
  const token=String(req.query.token||"");
  const path=String(req.query.path||"");
  if(!token||!/^[0-9a-f-]{36}\\/[0-9a-f-]{36}\\.mp3$/i.test(path))return res.status(400).json({valid:false});
  const db=admin();
  const {data:song}=await db.from("songs").select("id,audio_path").eq("audio_path",path).maybeSingle();
  if(!song)return res.status(404).json({valid:false});
  const hash=crypto.createHash("sha256").update(token).digest("hex");
  const {data:g}=await db.from("download_grants").select("id").eq("token_hash",hash).eq("song_id",song.id).gt("expires_at",new Date().toISOString()).maybeSingle();
  res.set("Cache-Control","no-store").json({valid:!!g});
 }catch(e){res.status(500).json({valid:false});}
});
app.post("/api/grants",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Configura las variables de Supabase en Render."});
  const bearer=String(req.headers.authorization||"").match(/^Bearer (.+)$/i);
  if(!bearer)return res.status(401).json({error:"Inicia sesión como administradora."});
  const caller=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await caller.auth.getUser(bearer[1]);
  if(authError||!user)return res.status(401).json({error:"Sesión no válida."});
  const songId=String(req.body.songId||"");
  const db=admin();
  const {data:song,error}=await db.from("songs").select("id,owner_id").eq("id",songId).maybeSingle();
  if(error||!song||song.owner_id!==user.id)return res.status(403).json({error:"No tienes permiso para autorizar esta canción."});
  const token=crypto.randomBytes(32).toString("base64url");
  const token_hash=crypto.createHash("sha256").update(token).digest("hex");
  const expires_at=new Date(Date.now()+7*24*60*60*1000).toISOString();
  const {error:insertError}=await db.from("download_grants").insert({song_id:song.id,token_hash,created_by:user.id,expires_at});
  if(insertError)return res.status(500).json({error:"No se pudo guardar la autorización. Ejecuta la migración SQL."});
  res.set("Cache-Control","no-store").json({token,expiresAt:expires_at});
 }catch(e){res.status(500).json({error:"Error interno al autorizar la descarga."});}
});
app.listen(port,"0.0.0.0",()=>console.log("Private storage API listening on "+port));
