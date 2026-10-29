import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const app=express();
app.use(express.json({limit:"40mb"}));
const allowed=(process.env.ALLOWED_ORIGINS||"https://canta-con-el-corazon.onrender.com").split(",").map(s=>s.trim());
app.use(cors({origin(origin,cb){if(!origin||allowed.includes(origin))return cb(null,true);cb(new Error("Origin not allowed"));}}));
const port=process.env.PORT||10000;
const url=process.env.SUPABASE_URL;
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey=process.env.SUPABASE_ANON_KEY;
const ready=()=>Boolean(url&&serviceKey&&anonKey);
const admin=()=>createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});

// Garantiza que exista el bucket privado usado por las canciones.
// No lo hace público: las descargas siguen usando enlaces temporales firmados.
async function ensureAudioBucket(){
 if(!ready()){
  console.error("Supabase no está configurado: faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o SUPABASE_ANON_KEY.");
  return;
 }
 try{
  const db=admin();
  const {data:buckets,error:listError}=await db.storage.listBuckets();
  if(listError) throw listError;
  if(!(buckets||[]).some(b=>b.name==="songs-audio")){
   const {error:createError}=await db.storage.createBucket("songs-audio",{
    public:false,
    fileSizeLimit:"50MB",
    allowedMimeTypes:["audio/mpeg","audio/mp3"]
   });
   if(createError && !/already exists/i.test(createError.message||"")) throw createError;
   console.log("Bucket privado songs-audio creado.");
  }else{
   console.log("Bucket songs-audio encontrado.");
  }
 }catch(e){
  console.error("No se pudo verificar/crear el bucket songs-audio:",e?.message||e);
 }
}
ensureAudioBucket();
app.get("/health",(req,res)=>res.json({ok:true,configured:ready(),storage:"private-signed-urls"}));
app.get("/api/audio",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Storage privado aún no está configurado en el servidor."});
  const path=String(req.query.path||"");
  if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(path))return res.status(400).json({error:"Ruta de audio no válida."});
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
  if(!token||!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(path))return res.status(400).json({valid:false});
  const db=admin();
  const {data:song}=await db.from("songs").select("id,audio_path").eq("audio_path",path).maybeSingle();
  if(!song)return res.status(404).json({valid:false});
  const hash=crypto.createHash("sha256").update(token).digest("hex");
  const {data:g}=await db.from("download_grants").select("id").eq("token_hash",hash).eq("song_id",song.id).gt("expires_at",new Date().toISOString()).maybeSingle();
  res.set("Cache-Control","no-store").json({valid:!!g});
 }catch(e){res.status(500).json({valid:false});}
});

app.post("/api/songs",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Faltan variables de Supabase en Render."});
  const bearer=String(req.headers.authorization||"").match(/^Bearer (.+)$/i);
  if(!bearer)return res.status(401).json({error:"Inicia sesión como administradora."});
  const caller=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await caller.auth.getUser(bearer[1]);
  if(authError||!user)return res.status(401).json({error:"La sesión expiró. Inicia sesión nuevamente."});
  const body=req.body||{};
  const id=String(body.id||"");
  if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:"ID de canción no válido."});
  const title=String(body.title||"").trim(),recipient=String(body.recipient||"").trim(),dedication=String(body.dedication||"").trim();
  if(!title||!recipient||!dedication)return res.status(400).json({error:"Completa título, destinatario y dedicatoria."});
  const db=admin();
  const {data:old,error:oldError}=await db.from("songs").select("id,owner_id,audio_path").eq("id",id).maybeSingle();
  if(oldError)return res.status(500).json({error:"No se pudo comprobar la canción en la base de datos: "+oldError.message});
  if(old&&old.owner_id!==user.id)return res.status(403).json({error:"No tienes permiso para editar esta canción."});
  let audio_path=old?.audio_path||null;
  if(body.audioBase64){
   const encoded=String(body.audioBase64);
   if(encoded.length>36*1024*1024)return res.status(413).json({error:"El MP3 supera el límite de 25 MB."});
   const buffer=Buffer.from(encoded,"base64");
   if(buffer.length>25*1024*1024)return res.status(413).json({error:"El MP3 supera el límite de 25 MB."});
   const path=user.id+"/"+id+".mp3";
   const {error:uploadError}=await db.storage.from("songs-audio").upload(path,buffer,{contentType:"audio/mpeg",upsert:true,cacheControl:"3600"});
   if(uploadError)return res.status(500).json({error:"No se pudo subir el MP3 al almacenamiento: "+uploadError.message});
   audio_path=path;
  }
  if(!audio_path)return res.status(400).json({error:"Selecciona un MP3 antes de guardar."});
  const row={id,title,recipient,dedication,lyrics:String(body.lyrics||""),theme:String(body.theme||"romantico"),audio_path,audio_url:null,owner_id:user.id,published:true,updated_at:new Date().toISOString()};
  const {error:saveError}=await db.from("songs").upsert(row);
  if(saveError)return res.status(500).json({error:"El archivo se subió, pero la base de datos rechazó la canción: "+saveError.message});
  res.set("Cache-Control","no-store").json({ok:true,song:row});
 }catch(e){console.error("Error saving song:",e?.message||e);res.status(500).json({error:"Error interno al guardar la canción."});}
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
  if(insertError){console.error("download_grants insert failed:",insertError.message,insertError.code);return res.status(500).json({error:"No se pudo guardar la autorización: "+insertError.message+" ("+(insertError.code||"sin código") + "). Ejecuta supabase-download-grants.sql en Supabase SQL Editor."});}
  res.set("Cache-Control","no-store").json({token,expiresAt:expires_at});
 }catch(e){res.status(500).json({error:"Error interno al autorizar la descarga."});}
});
app.listen(port,"0.0.0.0",()=>console.log("Private storage API listening on "+port));
