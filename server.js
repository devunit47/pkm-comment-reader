import http from 'node:http';
import { readFile } from 'node:fs/promises';
const files = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
const types = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
http.createServer(async (req,res)=>{
  const file=files[new URL(req.url,'http://localhost').pathname];
  if(!file){res.writeHead(404);res.end('Not found');return;}
  try{res.writeHead(200,{'Content-Type':types[file.split('.').pop()]});res.end(await readFile(new URL(file,import.meta.url)));}
  catch{res.writeHead(500);res.end('Unable to load file');}
}).listen(5173,'127.0.0.1',()=>console.log('Open http://localhost:5173'));
