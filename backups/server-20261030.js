import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import ffmpegPath from "ffmpeg-static";
const execFileAsync=promisify(execFile);

const app=express();
app.use(express.json({limit:"40mb"}));
const allowed=[...new Set(["https://canta-con-el-corazon.onrender.com",...(process.env.ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean)])];
const corsOptions={origin(origin,cb){if(!origin||allowed.includes(origin))return cb(null,true);console.error("CORS blocked origin:",origin);cb(new Error("Origin not allowed: "+origin));},methods:["GET","POST","OPTIONS"],allowedHeaders:["Content-Type","Authorization"],maxAge:86400};
app.use(cors(corsOptions));
app.options(/.*/,cors(corsOptions));
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
app.post("/api/preview-links",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Supabase no está configurado."});
  const bearer=String(req.headers.authorization||"").match(/^Bearer (.+)$/i);
  if(!bearer)return res.status(401).json({error:"Inicia sesión como administradora."});
  const caller=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await caller.auth.getUser(bearer[1]);
  if(authError||!user)return res.status(401).json({error:"Sesión no válida."});
  const songId=String(req.body?.songId||"");const db=admin();
  const {data:song,error}=await db.from("songs").select("id,owner_id,audio_path,published").eq("id",songId).maybeSingle();
  if(error||!song||song.owner_id!==user.id)return res.status(403).json({error:"No tienes permiso para generar enlaces de esta canción."});
  const {count,error:countError}=await db.from("song_preview_links").select("id",{count:"exact",head:true}).eq("song_id",songId);
  if(countError)return res.status(503).json({error:"No se pudo consultar el historial de enlaces de muestra."});
  const token=crypto.randomBytes(32).toString("base64url");
  const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
  const {error:insertError}=await db.from("song_preview_links").insert({song_id:songId,token_hash:tokenHash,created_by:user.id,download_enabled:false});
  if(insertError)return res.status(500).json({error:"No se pudo guardar el enlace de muestra."});
  res.set("Cache-Control","no-store").json({ok:true,token,number:(count||0)+1,audio_path:song.audio_path});
 }catch(e){console.error("preview link:",e?.message||e);res.status(500).json({error:"Error al generar el enlace."});}
});
app.post("/api/preview-download-toggle",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Supabase no está configurado."});
  const bearer=String(req.headers.authorization||"").match(/^Bearer (.+)$/i);
  if(!bearer)return res.status(401).json({error:"Inicia sesión como administradora."});
  const caller=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await caller.auth.getUser(bearer[1]);
  if(authError||!user)return res.status(401).json({error:"Sesión no válida."});
  const songId=String(req.body?.songId||""),token=String(req.body?.token||""),enabled=Boolean(req.body?.enabled);
  if(!/^[0-9a-f-]{36}$/i.test(songId)||!/^[A-Za-z0-9_-]{40,100}$/.test(token))return res.status(400).json({error:"Canción o enlace no válido."});
  const db=admin();
  const {data:song,error:songError}=await db.from("songs").select("id,owner_id").eq("id",songId).maybeSingle();
  if(songError||!song||song.owner_id!==user.id)return res.status(403).json({error:"No tienes permiso para cambiar esta canción."});
  const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
  const {data:link,error:linkError}=await db.from("song_preview_links").update({download_enabled:enabled}).eq("song_id",songId).eq("token_hash",tokenHash).select("id").maybeSingle();
  if(linkError)return res.status(503).json({error:"Actualiza la tabla song_preview_links con el archivo SQL de descargas."});
  if(!link)return res.status(404).json({error:"No se encontró ese enlace de muestra."});
  res.set("Cache-Control","no-store").json({ok:true,enabled});
 }catch(e){console.error("preview download toggle:",e?.message||e);res.status(500).json({error:"No se pudo cambiar el permiso de descarga."});}
});
app.get("/api/verify-preview-download",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({valid:false});
  const token=String(req.query.token||""),path=String(req.query.path||"");
  if(!/^[A-Za-z0-9_-]{40,100}$/.test(token)||!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(path))return res.status(400).json({valid:false});
  const hash=crypto.createHash("sha256").update(token).digest("hex"),db=admin();
  const {data:song}=await db.from("songs").select("id,audio_path").eq("audio_path",path).maybeSingle();
  if(!song)return res.status(404).json({valid:false});
  const {data:link,error}=await db.from("song_preview_links").select("id").eq("song_id",song.id).eq("token_hash",hash).eq("download_enabled",true).maybeSingle();
  res.set("Cache-Control","no-store").json({valid:!!link&&!error});
 }catch(e){res.status(500).json({valid:false});}
});
app.post("/api/preview/start",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"El servicio de vista previa no está configurado."});
  const path=String(req.body?.path||""),token=String(req.body?.token||"");
  if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(path)||!/^[A-Za-z0-9_-]{40,100}$/.test(token))return res.status(400).json({error:"Enlace de muestra no válido."});
  const db=admin(),hash=crypto.createHash("sha256").update(token).digest("hex");
  const {data:link,error}=await db.from("song_preview_links").select("id,song_id,started_at,completed_at").eq("token_hash",hash).maybeSingle();
  if(error||!link)return res.status(410).json({error:"Este enlace no existe o ya venció."});
  if(link.completed_at)return res.status(410).json({error:"Esta muestra ya se escuchó. Solicita otro enlace."});
  if(link.started_at)return res.status(409).json({error:"Este enlace ya se inició. Usa otro de los enlaces enviados."});
  const {data:song,error:songError}=await db.from("songs").select("id,published,audio_path").eq("id",link.song_id).maybeSingle();
  if(songError||!song){console.error("Preview song lookup failed:",songError?.message||"missing song",{songId:link.song_id});return res.status(404).json({error:"No se encontró la canción vinculada a esta muestra."});}
  if(song.audio_path!==path){console.error("Preview audio path mismatch:",{songId:link.song_id,requestedPath:path,storedPath:song.audio_path});return res.status(409).json({error:"El enlace de muestra apunta a un archivo anterior. Genera un enlace nuevo desde el panel."});}
  const {data:updated,error:updateError}=await db.from("song_preview_links").update({started_at:new Date().toISOString()}).eq("id",link.id).is("started_at",null).is("completed_at",null).select("id").maybeSingle();
  if(updateError||!updated)return res.status(409).json({error:"Este enlace ya se utilizó. Solicita otro."});
  res.set("Cache-Control","no-store").json({ok:true,token});
 }catch(e){console.error("preview start:",e?.message||e);res.status(500).json({error:"No se pudo iniciar la muestra."});}
});
app.post("/api/preview/complete",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"El servicio de vista previa no está configurado."});
  const path=String(req.body?.path||""),token=String(req.body?.token||"");
  if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(path)||!/^[A-Za-z0-9_-]{40,100}$/.test(token))return res.status(400).json({error:"Solicitud no válida."});
  const db=admin(),hash=crypto.createHash("sha256").update(token).digest("hex");
  const {data:link,error}=await db.from("song_preview_links").select("id,song_id,completed_at").eq("token_hash",hash).maybeSingle();
  if(error||!link||link.completed_at)return res.status(409).json({error:"Este enlace ya fue utilizado."});
  const {data:song}=await db.from("songs").select("id").eq("id",link.song_id).eq("audio_path",path).maybeSingle();
  if(!song)return res.status(404).json({error:"Canción no encontrada."});
  const {data:updated,error:updateError}=await db.from("song_preview_links").update({completed_at:new Date().toISOString()}).eq("id",link.id).not("started_at","is",null).is("completed_at",null).select("id").maybeSingle();
  if(updateError||!updated)return res.status(409).json({error:"No se pudo registrar el final de la muestra."});
  res.set("Cache-Control","no-store").json({ok:true,completed:true});
 }catch(e){console.error("preview complete:",e?.message||e);res.status(500).json({error:"No se pudo finalizar la muestra."});}
});
app.get("/api/admin-audio-url",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Supabase no está configurado en el servidor."});
  const bearer=String(req.headers.authorization||"").match(/^Bearer (.+)$/i);
  if(!bearer)return res.status(401).json({error:"Inicia sesión como administradora."});
  const caller=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await caller.auth.getUser(bearer[1]);
  if(authError||!user)return res.status(401).json({error:"La sesión expiró. Inicia sesión nuevamente."});
  const songId=String(req.query.songId||"");
  if(!/^[0-9a-f-]{36}$/i.test(songId))return res.status(400).json({error:"ID de canción no válido."});
  const db=admin();
  const {data:song,error}=await db.from("songs").select("id,owner_id,audio_path").eq("id",songId).eq("owner_id",user.id).maybeSingle();
  if(error||!song)return res.status(404).json({error:"Canción no encontrada o sin permiso."});
  if(!song.audio_path)return res.status(404).json({error:"La canción no tiene archivo MP3."});
  const {data,error:signedError}=await db.storage.from("songs-audio").createSignedUrl(song.audio_path,3600);
  if(signedError||!data?.signedUrl){console.error("Admin signed audio URL failed:",signedError?.message||"empty URL");return res.status(502).json({error:"No se pudo generar el enlace seguro del MP3."});}
  res.set("Cache-Control","no-store").json({ok:true,url:data.signedUrl});
 }catch(e){console.error("Admin audio URL error:",e?.message||e);res.status(500).json({error:"Error al preparar el reproductor."});}
});
app.get("/api/audio",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Storage privado aún no está configurado en el servidor."});
  const path=String(req.query.path||"");
  console.log("Audio request:",{pathPresent:!!path,grantPresent:!!req.query.grant,previewPresent:!!req.query.preview});
  if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(path))return res.status(400).json({error:"Ruta de audio no válida."});
  const db=admin();
  const {data:song,error}=await db.from("songs").select("id,published,audio_path,owner_id").eq("audio_path",path).maybeSingle();
  if(error||!song){console.error("Audio song lookup failed:",error?.message||"song not found");return res.status(404).json({error:"Canción no encontrada."});}
  const grant=String(req.query.grant||"");
  const preview=String(req.query.preview||"");
  let grantAuthorized=false;
  if(grant){
   const grantHash=crypto.createHash("sha256").update(grant).digest("hex");
   const {data:g}=await db.from("download_grants").select("id,song_id,expires_at").eq("token_hash",grantHash).eq("song_id",song.id).gt("expires_at",new Date().toISOString()).maybeSingle();
   grantAuthorized=!!g;
  }
  if(!grantAuthorized){
   if(!preview)return res.status(403).json({error:"Inicia la vista previa desde el botón del regalo."});
   const previewHash=crypto.createHash("sha256").update(preview).digest("hex");
   const {data:session,error:sessionError}=await db.from("song_preview_links").select("id,started_at,completed_at,download_enabled").eq("song_id",song.id).eq("token_hash",previewHash).maybeSingle();
   const activePreview=!!session&&!!session.started_at&&!session.completed_at;
   const downloadEnabled=!!session&&!!session.download_enabled;
   if(sessionError||(!activePreview&&!downloadEnabled)){console.error("Audio preview permission denied:",{sessionError:sessionError?.message||null,activePreview,downloadEnabled});return res.status(403).json({error:"La vista previa no está activa o ya fue utilizada."});}
  }
  // Servir el MP3 desde esta API evita fallos CORS al seguir la URL firmada de Supabase.
  const {data:audioFile,error:audioError}=await db.storage.from("songs-audio").download(path);
  if(audioError||!audioFile){console.error("Supabase audio download failed:",audioError?.message||"empty file");return res.status(502).json({error:"No se pudo recuperar el archivo de audio. Inténtalo nuevamente."});}
  const audioBuffer=Buffer.from(await audioFile.arrayBuffer());
  if(!audioBuffer.length)return res.status(502).json({error:"El archivo de audio está vacío."});
  res.set({"Content-Type":"audio/mpeg","Content-Length":String(audioBuffer.length),"Cache-Control":"no-store","Access-Control-Expose-Headers":"Content-Length"});
  res.send(audioBuffer);
 }catch(e){console.error("Audio route unexpected error:",e?.message||e);res.status(500).json({error:"Error interno al preparar el audio."});}
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

app.post("/api/share-video",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"El almacenamiento no está configurado."});
  const audioPath=String(req.query.path||"");
  const previewToken=String(req.query.previewToken||"");
  const grantToken=String(req.query.grantToken||"");
  if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(audioPath))return res.status(400).json({error:"Ruta de canción no válida."});
  const db=admin();
  const {data:song}=await db.from("songs").select("id,audio_path").eq("audio_path",audioPath).maybeSingle();
  if(!song)return res.status(404).json({error:"No se encontró la canción."});
  let allowedDownload=false;
  if(previewToken&&/^[A-Za-z0-9_-]{40,100}$/.test(previewToken)){
   const hash=crypto.createHash("sha256").update(previewToken).digest("hex");
   const {data:link}=await db.from("song_preview_links").select("id").eq("song_id",song.id).eq("token_hash",hash).eq("download_enabled",true).maybeSingle();
   allowedDownload=!!link;
  }
  if(!allowedDownload&&grantToken&&/^[A-Za-z0-9_-]{40,100}$/.test(grantToken)){
   const hash=crypto.createHash("sha256").update(grantToken).digest("hex");
   const {data:grant}=await db.from("download_grants").select("id").eq("song_id",song.id).eq("token_hash",hash).gt("expires_at",new Date().toISOString()).maybeSingle();
   allowedDownload=!!grant;
  }
  if(!allowedDownload)return res.status(403).json({error:"No hay autorización vigente para crear el enlace compartible."});
  const chunks=[];let total=0;const maxBytes=30*1024*1024;
  for await(const chunk of req){total+=chunk.length;if(total>maxBytes)return res.status(413).json({error:"El MP4 supera el límite de 30 MB."});chunks.push(chunk);}
  if(!total)return res.status(400).json({error:"No se recibió el MP4."});
  const {data:buckets,error:listError}=await db.storage.listBuckets();
  if(listError)throw listError;
  if(!(buckets||[]).some(b=>b.name==="shared-videos")){
   const {error:createError}=await db.storage.createBucket("shared-videos",{public:true,fileSizeLimit:"30MB",allowedMimeTypes:["video/mp4"]});
   if(createError&&!/already exists/i.test(createError.message||""))throw createError;
  }
  const objectPath=song.id+"/"+crypto.randomUUID()+".mp4";
  const {error:uploadError}=await db.storage.from("shared-videos").upload(objectPath,Buffer.concat(chunks),{contentType:"video/mp4",upsert:false,cacheControl:"31536000"});
  if(uploadError)throw uploadError;
  const {data:{publicUrl}}=db.storage.from("shared-videos").getPublicUrl(objectPath);
  res.set("Cache-Control","no-store").json({ok:true,videoUrl:publicUrl});
 }catch(e){console.error("share MP4 upload:",e?.message||e);res.status(500).json({error:"No se pudo crear el enlace público del video: "+(e?.message||"error interno")});}
});

app.post("/api/convert-video",async(req,res)=>{
 console.log("MP4 conversion request received; origin:",req.headers.origin||"(none)");
 let dir="";
 try{
  if(!ready())return res.status(503).json({error:"El servicio de conversión no está configurado."});
  const audioPath=String(req.query.path||"");
  const previewToken=String(req.query.previewToken||"");
  const grantToken=String(req.query.grantToken||"");
  if(!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp3$/i.test(audioPath))return res.status(400).json({error:"Ruta de canción no válida."});
  const db=admin();
  const {data:song}=await db.from("songs").select("id,audio_path").eq("audio_path",audioPath).maybeSingle();
  if(!song)return res.status(404).json({error:"No se encontró la canción."});
  let allowedDownload=false;
  if(previewToken&&/^[A-Za-z0-9_-]{40,100}$/.test(previewToken)){
   const hash=crypto.createHash("sha256").update(previewToken).digest("hex");
   const {data:link}=await db.from("song_preview_links").select("id").eq("song_id",song.id).eq("token_hash",hash).eq("download_enabled",true).maybeSingle();
   allowedDownload=!!link;
  }
  if(!allowedDownload&&grantToken&&/^[A-Za-z0-9_-]{40,100}$/.test(grantToken)){
   const hash=crypto.createHash("sha256").update(grantToken).digest("hex");
   const {data:grant}=await db.from("download_grants").select("id").eq("song_id",song.id).eq("token_hash",hash).gt("expires_at",new Date().toISOString()).maybeSingle();
   allowedDownload=!!grant;
  }
  if(!allowedDownload){console.warn("MP4 conversion denied: no valid download grant for song",song.id);return res.status(403).json({error:"La descarga de video no está autorizada para este enlace."});}
  const chunks=[];let total=0;const maxBytes=45*1024*1024;
  for await(const chunk of req){total+=chunk.length;if(total>maxBytes){console.warn("MP4 input rejected at size limit:",total);return res.status(413).json({error:"La grabación del video pesa demasiado. Intenta nuevamente con una canción más corta o una conexión estable."});}chunks.push(chunk);}
  if(!total)return res.status(400).json({error:"No se recibió ningún video para convertir."});
  dir=await mkdtemp(path.join(os.tmpdir(),"cch-video-"));
  const input=path.join(dir,"input.webm"),output=path.join(dir,"output.mp4");
  await writeFile(input,Buffer.concat(chunks));chunks.length=0;
  console.log("Starting low-memory MP4 conversion:",{inputMB:Number((total/1024/1024).toFixed(2))});
  await execFileAsync(ffmpegPath,["-y","-threads","1","-i",input,"-map","0:v:0","-map","0:a:0?","-vf","scale='min(480,iw)':-2:force_original_aspect_ratio=decrease","-c:v","libx264","-threads","1","-preset","ultrafast","-tune","fastdecode","-crf","32","-maxrate","550k","-bufsize","1100k","-pix_fmt","yuv420p","-r","15","-c:a","aac","-b:a","64k","-ac","2","-movflags","+faststart","-shortest",output],{timeout:600000,maxBuffer:2*1024*1024});
  const mp4=await readFile(output);
  if(!mp4.length)return res.status(500).json({error:"La conversión produjo un MP4 vacío."});
  if(mp4.length>30*1024*1024)return res.status(413).json({error:"El MP4 supera el límite seguro de 30 MB ("+(mp4.length/1024/1024).toFixed(1)+" MB). Reduce la duración de la canción."});
  console.log("Low-memory MP4 ready:",{megabytes:Number((mp4.length/1024/1024).toFixed(2)),videoCodec:"H.264",audioCodec:"AAC"});
  const headers={"Content-Type":"video/mp4","Content-Disposition":'attachment; filename="canta-con-el-corazon.mp4"',"Cache-Control":"no-store","Content-Length":String(mp4.length)};
  res.set(headers);
  res.send(mp4);
 }catch(e){console.error("video mp4 conversion:",e?.message||e);if(!res.headersSent)res.status(500).json({error:"No se pudo preparar el MP4: "+(e?.message||"error interno")});}
 finally{if(dir)await rm(dir,{recursive:true,force:true}).catch(()=>{});}
});


/* Busca clips de fondo en Pixabay. Las respuestas se guardan 24 h según las reglas de la API. */
const pixabayVideoCache=new Map();
app.get("/api/pixabay/videos",async(req,res)=>{
 try{
  const apiKey=String(process.env.PIXABAY_API_KEY||"").trim();
  console.log("Pixabay key diagnostic:", { present: Boolean(apiKey), length: apiKey.length });
  if(!apiKey)return res.status(503).json({error:"La búsqueda de videos no está configurada. Añade PIXABAY_API_KEY en Render."});
  const allowedQueries=new Set(["romantic couple sunset","romantic roses","sunset ocean","romantic candles","birthday celebration","wedding anniversary","beautiful nature","friendship","serenade romantic"]);
  const raw=String(req.query.q||"romantic couple sunset").toLowerCase().replace(/[^a-z0-9 áéíóúñ-]/gi,"").trim().slice(0,80);
  const q=allowedQueries.has(raw)?raw:"romantic couple sunset";
  const cacheKey=q;
  const cached=pixabayVideoCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return res.set("Cache-Control","public, max-age=3600").json(cached.data);
  const endpoint="https://pixabay.com/api/videos/?key="+encodeURIComponent(apiKey)+"&q="+encodeURIComponent(q)+"&safesearch=true&per_page=12&order=popular";
  const response=await fetch(endpoint,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(12000)});
  if(!response.ok){const errorBody=(await response.text()).slice(0,500);console.error("Pixabay API status:",response.status,"detail:",errorBody);return res.status(response.status===429?429:502).json({error:response.status===429?"Pixabay alcanzó el límite temporal de búsquedas. Inténtalo más tarde.":"Pixabay no pudo completar la búsqueda."});}
  const payload=await response.json();
  const hits=(payload.hits||[]).map(v=>({id:v.id,tags:String(v.tags||"").slice(0,180),duration:v.duration,source:v.pageURL,preview:v.videos?.small?.url||v.videos?.medium?.url||v.videos?.tiny?.url,thumbnail:v.videos?.small?.thumbnail||v.videos?.medium?.thumbnail||v.videos?.tiny?.thumbnail})).filter(v=>v.preview);
  const data={provider:"Pixabay",attributionUrl:"https://pixabay.com/videos/",query:q,videos:hits};
  pixabayVideoCache.set(cacheKey,{data,expires:Date.now()+24*60*60*1000});
  res.set("Cache-Control","public, max-age=3600").json(data);
 }catch(e){console.error("Pixabay video search:",e?.message||e);res.status(502).json({error:"No se pudo buscar videos en Pixabay en este momento."});}
});

app.listen(port,"0.0.0.0",()=>console.log("Private storage API listening on "+port));
