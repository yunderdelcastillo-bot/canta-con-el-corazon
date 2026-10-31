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
const corsOptions={origin(origin,cb){if(!origin||allowed.includes(origin))return cb(null,true);console.error("CORS blocked origin:",origin);cb(new Error("Origin not allowed: "+origin));},methods:["GET","POST","PUT","DELETE","OPTIONS"],allowedHeaders:["Content-Type","Authorization"],maxAge:86400};
app.use(cors(corsOptions));
app.options(/.*/,cors(corsOptions));
const port=process.env.PORT||10000;
const MEDIA_BUCKET="cch-media-library";
const MEDIA_CATEGORIES=new Set(["romantico","cumpleanos","aniversario","serenata","homenaje","amistad","familia","dia-madre","dia-padre","otros"]);

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

async function mediaUser(req){
 const bearer=String(req.headers.authorization||"").match(/^Bearer (.+)$/i);
 if(!bearer)return null;
 const caller=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:{user},error}=await caller.auth.getUser(bearer[1]);
 return error?null:user;
}
async function ensureMediaBucket(){
 const db=admin();const {data,error}=await db.storage.listBuckets();if(error)throw error;
 if(!(data||[]).some(b=>b.name===MEDIA_BUCKET)){
  const {error:createError}=await db.storage.createBucket(MEDIA_BUCKET,{public:true,fileSizeLimit:"50MB",allowedMimeTypes:["video/mp4","video/webm","video/quicktime","image/jpeg","image/png","image/webp"]});
  if(createError&&!/already exists/i.test(createError.message||""))throw createError;
 }
}
app.get("/api/media/public",async(req,res)=>{
 try{
  const category=String(req.query.category||"");
  if(!MEDIA_CATEGORIES.has(category))return res.status(400).json({error:"Categoría no válida."});
  const db=admin();const {data,error}=await db.storage.from(MEDIA_BUCKET).list(category,{limit:100,sortBy:{column:"created_at",order:"desc"}});
  if(error){if(/not found|does not exist/i.test(error.message||""))return res.json({items:[]});throw error;}
  const items=(data||[]).filter(x=>x.name&&!x.name.startsWith(".")).map(x=>{const path=category+"/"+x.name;const {data:{publicUrl}}=db.storage.from(MEDIA_BUCKET).getPublicUrl(path);return {name:x.name,url:publicUrl,mimeType:x.metadata?.mimetype||"",createdAt:x.created_at||null};});
  res.set("Cache-Control","public, max-age=60").json({items});
 }catch(e){console.error("media public list:",e?.message||e);res.status(500).json({error:"No se pudo cargar la biblioteca multimedia."});}
});
app.get("/api/media",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Supabase no está configurado."});
  const user=await mediaUser(req);if(!user)return res.status(401).json({error:"Inicia sesión como administradora."});
  const db=admin();await ensureMediaBucket();const items=[];
  for(const category of MEDIA_CATEGORIES){const {data,error}=await db.storage.from(MEDIA_BUCKET).list(category,{limit:100,sortBy:{column:"created_at",order:"desc"}});if(error)continue;
   for(const x of data||[]){if(!x.name||x.name.startsWith("."))continue;const path=category+"/"+x.name;const {data:{publicUrl}}=db.storage.from(MEDIA_BUCKET).getPublicUrl(path);items.push({category,name:x.name,url:publicUrl,mimeType:x.metadata?.mimetype||"",size:x.metadata?.size||0,createdAt:x.created_at||null});}
  }
  res.set("Cache-Control","no-store").json({items});
 }catch(e){console.error("media admin list:",e?.message||e);res.status(500).json({error:"No se pudo listar la biblioteca."});}
});
app.put("/api/media",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Supabase no está configurado."});
  const user=await mediaUser(req);if(!user)return res.status(401).json({error:"Inicia sesión como administradora."});
  const category=String(req.query.category||""),mime=String(req.headers["content-type"]||"").split(";")[0].trim().toLowerCase();
  const extByMime={"video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","image/jpeg":"jpg","image/png":"png","image/webp":"webp"};
  if(!MEDIA_CATEGORIES.has(category)||!extByMime[mime])return res.status(400).json({error:"Categoría o formato no permitido."});
  const chunks=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>50*1024*1024)return res.status(413).json({error:"El archivo supera 50 MB."});chunks.push(chunk);}
  if(!total)return res.status(400).json({error:"No se recibió ningún archivo."});
  const name=crypto.randomUUID()+"."+extByMime[mime],db=admin();await ensureMediaBucket();
  const {error}=await db.storage.from(MEDIA_BUCKET).upload(category+"/"+name,Buffer.concat(chunks),{contentType:mime,upsert:false,cacheControl:"3600"});
  if(error)throw error;
  const {data:{publicUrl}}=db.storage.from(MEDIA_BUCKET).getPublicUrl(category+"/"+name);
  res.status(201).json({ok:true,item:{category,name,url:publicUrl,mimeType:mime,size:total}});
 }catch(e){console.error("media upload:",e?.message||e);res.status(500).json({error:"No se pudo subir el archivo: "+(e?.message||"error interno")});}
});
app.delete("/api/media",async(req,res)=>{
 try{
  if(!ready())return res.status(503).json({error:"Supabase no está configurado."});
  const user=await mediaUser(req);if(!user)return res.status(401).json({error:"Inicia sesión como administradora."});
  const category=String(req.query.category||""),name=String(req.query.name||"");
  if(!MEDIA_CATEGORIES.has(category)||!/^[0-9a-f-]{36}\.(mp4|webm|mov|jpg|png|webp)$/i.test(name))return res.status(400).json({error:"Archivo no válido."});
  const {error}=await admin().storage.from(MEDIA_BUCKET).remove([category+"/"+name]);if(error)throw error;
  res.json({ok:true});
 }catch(e){console.error("media delete:",e?.message||e);res.status(500).json({error:"No se pudo eliminar el archivo."});}
});

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

const videoConversionJobs=new Map();
app.post("/api/convert-video",async(req,res)=>{
 console.log("MP4 conversion job received; origin:",req.headers.origin||"(none)");
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
  if(!allowedDownload)return res.status(403).json({error:"La descarga de video no está autorizada para este enlace."});
  const chunks=[];let total=0;const maxBytes=45*1024*1024;
  for await(const chunk of req){total+=chunk.length;if(total>maxBytes)return res.status(413).json({error:"La grabación del video pesa demasiado. Intenta nuevamente con una canción más corta o una conexión estable."});chunks.push(chunk);}
  if(!total)return res.status(400).json({error:"No se recibió ningún video para convertir."});
  const jobId=crypto.randomUUID();
  videoConversionJobs.set(jobId,{status:"processing",createdAt:Date.now(),songId:song.id});
  res.status(202).set("Cache-Control","no-store").json({ok:true,jobId,status:"processing"});
  setImmediate(async()=>{
   let dir="";
   try{
    const {data:originalAudio,error:originalAudioError}=await db.storage.from("songs-audio").download(audioPath);
    if(originalAudioError||!originalAudio)throw new Error("No se pudo recuperar el MP3 original: "+(originalAudioError?.message||"archivo vacío"));
    const originalAudioBuffer=Buffer.from(await originalAudio.arrayBuffer());
    if(!originalAudioBuffer.length)throw new Error("El MP3 original está vacío.");
    dir=await mkdtemp(path.join(os.tmpdir(),"cch-video-"));
    const input=path.join(dir,"input.webm"),audioInput=path.join(dir,"original.mp3"),output=path.join(dir,"output.mp4");
    await writeFile(input,Buffer.concat(chunks));chunks.length=0;
    await writeFile(audioInput,originalAudioBuffer);
    const conversionStartedAt=Date.now();
    console.log("Starting asynchronous full-song MP4 conversion:",{jobId,inputMB:Number((total/1024/1024).toFixed(2)),audioMB:Number((originalAudioBuffer.length/1024/1024).toFixed(2)),targetWidth:480,fps:15});
    await execFileAsync(ffmpegPath,["-y","-threads","1","-stream_loop","-1","-i",input,"-i",audioInput,"-map","0:v:0","-map","1:a:0","-vf","scale='trunc(min(480,iw)/2)*2':'trunc(ih*min(480,iw)/iw/2)*2'","-c:v","libx264","-threads","1","-preset","ultrafast","-tune","fastdecode","-crf","30","-maxrate","800k","-bufsize","1600k","-pix_fmt","yuv420p","-r","15","-c:a","aac","-b:a","96k","-ac","2","-movflags","+faststart","-shortest",output],{timeout:600000,maxBuffer:2*1024*1024});
    const mp4=await readFile(output);
    if(!mp4.length)throw new Error("La conversión produjo un MP4 vacío.");
    if(mp4.length>30*1024*1024)throw new Error("El MP4 supera el límite seguro de 30 MB ("+(mp4.length/1024/1024).toFixed(1)+" MB).");
    const {data:buckets,error:listError}=await db.storage.listBuckets();
    if(listError)throw listError;
    if(!(buckets||[]).some(b=>b.name==="shared-videos")){
     const {error:createError}=await db.storage.createBucket("shared-videos",{public:true,fileSizeLimit:"30MB",allowedMimeTypes:["video/mp4"]});
     if(createError&&!/already exists/i.test(createError.message||""))throw createError;
    }
    const objectPath=song.id+"/"+crypto.randomUUID()+".mp4";
    const {error:uploadError}=await db.storage.from("shared-videos").upload(objectPath,mp4,{contentType:"video/mp4",upsert:false,cacheControl:"31536000"});
    if(uploadError)throw uploadError;
    const {data:{publicUrl}}=db.storage.from("shared-videos").getPublicUrl(objectPath);
    console.log("Asynchronous MP4 conversion ready:",{jobId,megabytes:Number((mp4.length/1024/1024).toFixed(2)),conversionSeconds:Number(((Date.now()-conversionStartedAt)/1000).toFixed(1))});
    videoConversionJobs.set(jobId,{status:"done",videoUrl:publicUrl,createdAt:Date.now(),songId:song.id});
   }catch(e){
    console.error("Asynchronous video conversion failed:",jobId,e?.message||e);
    videoConversionJobs.set(jobId,{status:"error",error:e?.message||"No se pudo preparar el MP4.",createdAt:Date.now(),songId:song.id});
   }finally{if(dir)await rm(dir,{recursive:true,force:true}).catch(()=>{});}
  });
 }catch(e){
  console.error("MP4 conversion job setup failed:",e?.message||e);
  if(!res.headersSent)res.status(500).json({error:"No se pudo iniciar el proceso de conversión: "+(e?.message||"error interno")});
 }
});
app.get("/api/convert-video-status/:jobId",(req,res)=>{
 const job=videoConversionJobs.get(String(req.params.jobId||""));
 if(!job)return res.status(404).set("Cache-Control","no-store").json({error:"No encontramos este proceso. Vuelve a generar el video."});
 if(Date.now()-job.createdAt>30*60*1000){videoConversionJobs.delete(String(req.params.jobId));return res.status(410).set("Cache-Control","no-store").json({error:"El proceso expiró. Vuelve a intentarlo."});}
 res.set("Cache-Control","no-store").json({status:job.status,...(job.status==="done"?{videoUrl:job.videoUrl}:{}),...(job.status==="error"?{error:job.error}:{})});
});

// Generador de letras originales mediante proveedor compatible con OpenAI.
const lyricRateLimits=new Map();
app.post("/api/lyrics/generate",async(req,res)=>{
 try{
  const apiKey=String(process.env.GEMINI_API_KEY||"").trim();
  if(!apiKey)return res.status(503).json({error:"La IA de letras aún no está conectada. El administrador debe configurar GEMINI_API_KEY en Render."});
  const body=req.body||{};
  const adminRequest=Boolean(req.headers.authorization);
  if(adminRequest){
   const user=await mediaUser(req);
   if(!user)return res.status(401).json({error:"Tu sesión de administrador expiró. Inicia sesión nuevamente."});
  }
  const ip=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim();
  const bucket=(adminRequest?"admin:":"client:")+ip;
  const now=Date.now(),windowMs=60*60*1000;
  const record=lyricRateLimits.get(bucket)||{start:now,count:0};
  if(now-record.start>windowMs){record.start=now;record.count=0;}
  const limit=adminRequest?30:8;
  if(record.count>=limit)return res.status(429).json({error:"Alcanzaste el límite temporal de generación. Inténtalo más tarde."});
  const fields=["buyer","recipient","occasion","story","style","voice","customGenre","phrase","duration","tone","instruction"];
  const data={};for(const key of fields)data[key]=String(body[key]||"").trim().slice(0,key==="story"?3500:500);
  if(!data.recipient||!data.occasion||!data.story||!data.style)return res.status(400).json({error:"Completa el nombre de la persona, la ocasión, la historia y el género musical."});
  record.count++;lyricRateLimits.set(bucket,record);
  const systemPrompt="Eres compositor/a profesional de canciones personalizadas en español latino. Escribe letras completamente originales, emotivas, cantables y coherentes. No imites ni nombres artistas, no copies letras existentes ni pidas imitar voces. Usa exclusivamente los hechos proporcionados; no inventes parentescos, fechas, lugares ni sucesos. Conserva exactamente los nombres y frases importantes. Adapta vocabulario, ritmo, métrica y rimas al género solicitado. Evita clichés y repeticiones vacías. Devuelve solamente la letra final, sin explicaciones, sin markdown y sin instrucciones técnicas. Estructura con encabezados breves entre corchetes: [Intro], [Verso 1], [Verso 2], [Coro], [Puente], [Coro final] y [Outro], según convenga. Haz un coro memorable y natural. Longitud orientativa: 2:30 a 3:30 salvo indicación distinta.";
  const userPrompt="Crea una letra personalizada con estos datos:\n"+
   "Quién la solicita: "+(data.buyer||"No indicado")+"\n"+
   "Para quién: "+data.recipient+"\n"+
   "Ocasión: "+data.occasion+"\n"+
   "Historia y recuerdos: "+data.story+"\n"+
   "Género musical: "+data.style+"\n"+
   "Estilo adicional: "+(data.customGenre||"No indicado")+"\n"+
   "Voz: "+(data.voice||"No indicada")+"\n"+
   "Frase que debe incluirse: "+(data.phrase||"Ninguna")+"\n"+
   "Duración aproximada: "+(data.duration||"3 minutos")+"\n"+
   "Emoción/tono: "+(data.tone||"Según la historia")+"\n"+
   "Indicaciones adicionales: "+(data.instruction||"Ninguna")+"\n"+
   "Si hay contradicciones o falta información, no inventes; escribe una letra prudente y fiel a los datos.";
  const model=String(process.env.GEMINI_MODEL||"gemini-3.8-flash").trim();
  const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+":generateContent",{
   method:"POST",headers:{"x-goog-api-key":apiKey,"Content-Type":"application/json"},
   body:JSON.stringify({systemInstruction:{parts:[{text:systemPrompt}]},contents:[{role:"user",parts:[{text:userPrompt}]}],generationConfig:{thinkingConfig:{thinkingLevel:"low"},maxOutputTokens:2200}}),
   signal:AbortSignal.timeout(85000)
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){console.error("Gemini lyrics API error:",response.status,payload?.error?.message||"");return res.status(response.status===429?429:502).json({error:response.status===429?"Gemini alcanzó el límite temporal o de cuota. Revisa el uso de tu API.":"Gemini no pudo generar la letra. Revisa la clave y el modelo configurado."});}
  const lyrics=(payload?.candidates?.[0]?.content?.parts||[]).map(part=>part.text||"").join("\n").trim();
  if(!lyrics)return res.status(502).json({error:"Gemini respondió sin una letra. Inténtalo nuevamente."});
  res.set("Cache-Control","no-store").json({ok:true,lyrics,model});
 }catch(e){console.error("Gemini lyrics generation:",e?.message||e);res.status(502).json({error:e?.name==="TimeoutError"?"La generación tardó demasiado. Inténtalo otra vez.":"No se pudo conectar con Gemini."});}
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
