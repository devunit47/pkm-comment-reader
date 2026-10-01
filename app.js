const $ = id => document.getElementById(id);
let rules={};
try{rules=JSON.parse(localStorage.getItem('pokome-users')||'{}');if(!rules||typeof rules!=='object'||Array.isArray(rules))rules={};}catch{rules={};}
rules=Object.assign(Object.create(null),rules);
let messages=[], selected=null, socket=null, session=0, received=0;
const seen=new Set();
const supported='speechSynthesis' in window;
let voices=[];
function notify(text){$('notice').textContent=text;$('notice').style.display='block';clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('notice').style.display='none',3500);}
function save(){try{localStorage.setItem('pokome-users',JSON.stringify(rules));}catch{notify('設定を保存できませんでした。');}}
function rule(user){return Object.hasOwn(rules,user)?rules[user]:{};}
function make(tag,className,text){const el=document.createElement(tag);el.className=className;el.textContent=text;return el;}
function render(){
 const query=$('search').value.toLowerCase();
 const visible=messages.filter(m=>!rule(m.user).hidden&&( $('filter').value!=='first'||m.first)&&`${m.user} ${m.text}`.toLowerCase().includes(query));
 const list=$('comment-list');const bottom=list.scrollHeight-list.scrollTop-list.clientHeight<50;list.replaceChildren();
 for(const m of visible){const row=make('button',`comment${selected?.id===m.id?' selected':''}`,'');row.setAttribute('aria-pressed',String(selected?.id===m.id));const name=make('span','username','');name.append(make('span','avatar','▣'),document.createTextNode(m.user));row.append(name,make('span','message',m.text),make('span','time',m.time));row.onclick=()=>select(m);list.append(row);}
 if(!visible.length)list.append(make('p','empty','表示するコメントがありません。'));
 if(bottom)list.scrollTop=list.scrollHeight;
 $('count').replaceChildren(document.createTextNode(`${received} `),make('small','','件'));$('user-count').replaceChildren(document.createTextNode(`${seen.size} `),make('small','','人'));$('visible-count').textContent=visible.length;
 renderUsers();
}
function select(m){selected=m;$('preview-user').textContent=m.user;$('preview-text').textContent=m.text;$('selected-user').textContent=m.user;$('hide-user').disabled=false;$('mute-user').disabled=false;$('hide-user').textContent=rule(m.user).hidden?'↺ 非表示解除':'⊘ 非表示';$('mute-user').textContent=rule(m.user).muted?'↺ 除外解除':'◖ 読み上げ除外';render();}
function add(user,text){if(!text)return;const m={id:++session,user,text:text.slice(0,2000),first:!seen.has(user),time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})};seen.add(user);received++;messages.push(m);if(messages.length>300)messages.shift();render();if($('auto-speech').checked&&!rule(user).hidden&&!rule(user).muted)speak(m);}
let pendingSpeech=0;
function speak(m){if(!supported){notify('このブラウザは読み上げに対応していません。');return;}if(pendingSpeech>=20){return;}const utterance=new SpeechSynthesisUtterance(($('read-name').checked?`${m.user}さん。`:'')+m.text);utterance.lang='ja-JP';utterance.rate=Number($('rate').value);utterance.volume=Number($('volume').value);utterance.voice=voices.find(v=>v.voiceURI===$('voice').value)||null;pendingSpeech++;utterance.onstart=()=>{$('speech-status').textContent='読み上げ中';$('preview-user').textContent=m.user;$('preview-text').textContent=m.text;};const done=()=>{pendingSpeech=Math.max(0,pendingSpeech-1);if(!pendingSpeech)$('speech-status').textContent='待機中';};utterance.onend=done;utterance.onerror=done;window.speechSynthesis.speak(utterance);}
function stop(){if(supported)window.speechSynthesis.cancel();pendingSpeech=0;$('speech-status').textContent='待機中';}
function toggleRule(user,key){rules[user]={...rule(user),[key]:!rule(user)[key]};save();stop();if(selected?.user===user)select(selected);else render();notify(`${user} の設定を変更しました。`);}
function renderUsers(){const container=$('user-list');container.replaceChildren();const all=new Set([...seen,...Object.keys(rules)]);if(!all.size)container.append(make('p','empty','コメントを受信するとユーザーが表示されます。'));for(const user of all){const row=make('div','user-row','');row.append(make('strong','',user));for(const [key,label] of [['hidden','非表示'],['muted','読み上げ除外']]){const button=make('button','button',rule(user)[key]?`${label}を解除`:label);button.onclick=()=>toggleRule(user,key);row.append(button);}container.append(row);}}
function page(name){for(const item of ['home','users','settings'])$(`${item}-page`).hidden=item!==name;document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.page===name));$('page-title').textContent={home:'みんなの声が、ここに。',users:'ひとりひとりを、大切に。',settings:'配信と、つながろう。'}[name];}
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>page(b.dataset.page));$('open-settings').onclick=()=>page('settings');$('search').oninput=render;$('filter').onchange=render;
$('hide-user').onclick=()=>selected&&toggleRule(selected.user,'hidden');$('mute-user').onclick=()=>selected&&toggleRule(selected.user,'muted');$('read-selected').onclick=()=>selected?speak(selected):notify('コメントを選択してください。');$('stop-speech').onclick=stop;
$('auto-speech').onchange=()=>{$('speech-stat').textContent=$('auto-speech').checked?'ON':'OFF';if(!$('auto-speech').checked)stop();};
for(const id of ['volume','rate'])$(id).oninput=()=>{$(`${id}-value`).textContent=id==='volume'?`${Math.round($(id).value*100)}%`:`${$(id).value}×`;};
function loadVoices(){voices=window.speechSynthesis.getVoices();const current=$('voice').value;$('voice').replaceChildren(make('option','','ブラウザの標準音声'));$('voice').firstChild.value='';for(const v of voices.filter(v=>v.lang.startsWith('ja'))){const option=make('option','',v.name);option.value=v.voiceURI;$('voice').append(option);}$('voice').value=current;}
if(supported){loadVoices();window.speechSynthesis.addEventListener('voiceschanged',loadVoices);}else{$('auto-speech').disabled=true;$('speech-status').textContent='ブラウザ非対応';}
$('clear').onclick=()=>{messages=[];selected=null;$('selected-user').textContent='コメントを選択してください';$('preview-user').textContent='ぽこめ Reader';$('preview-text').textContent='新しいコメントを待っています。';$('hide-user').disabled=true;$('mute-user').disabled=true;stop();render();};
const samples=[['minto_0123','ぽこめちゃん、はじめまして！いつも配信楽しみにしてます！'],['sakura_pink','今日も配信ありがとう 🌸'],['nekotan_22','こんばんは〜！'],['game_lover','このステージの雰囲気、すごく好き'],['yuki_4649','音声ちゃんと聞こえてるよ！'],['tanaka2525','ナイスプレイ！！'],['mochi_chan','お茶飲みながら、のんびり見てます 🍵'],['harupeko','そのキャラクターかわいい！'],['ao_ooo','初見です！よろしくお願いします'],['kana_night','きょうもおつかれさま ♡'],['minto_0123','次のステージも楽しみ！'],['sakura_pink','888888 👏']];
let sampleIndex=0;$('demo').onclick=()=>{const item=samples[sampleIndex++%samples.length];add(...item);};
function status(text,label=''){ $('connection-status').textContent=text;$('channel-label').textContent=label;$('connection-dot').style.background=text==='接続中'?'#ace5cd':'#d9bd7c';}
function disconnect(){const old=socket;socket=null;if(old)old.close();status('未接続','接続してコメントを受信');}
$('disconnect').onclick=disconnect;
$('connect-form').onsubmit=e=>{e.preventDefault();const channel=$('channel').value.trim().toLowerCase();if(!/^[a-z0-9_]{1,25}$/.test(channel)){notify('英数字・アンダースコアでチャンネル名を入力してください。');return;}disconnect();status('接続準備中',`#${channel}`);let ws;try{ws=new WebSocket('wss://irc-ws.chat.twitch.tv:443');}catch{status('接続失敗','通信環境を確認してください');return;}socket=ws;const timer=setTimeout(()=>{if(socket===ws){disconnect();status('接続タイムアウト','再度接続してください');}},15000);ws.onopen=()=>{if(socket!==ws)return;ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');ws.send(`NICK justinfan${Math.floor(Math.random()*900000)+100000}`);ws.send(`JOIN #${channel}`);};ws.onmessage=e=>{if(socket!==ws)return;for(const line of e.data.split('\r\n')){if(line.startsWith('PING ')){ws.send(line.replace(/^PING/,'PONG'));continue;}if(line.includes(' 366 ')){clearTimeout(timer);status('接続中',`#${channel}`);page('home');}const match=line.match(/^(?:@([^ ]+) )?:([^! ]+)![^ ]+ PRIVMSG #[^ ]+ :([\s\S]*)$/);if(match){const tags=Object.fromEntries((match[1]||'').split(';').map(t=>{const i=t.indexOf('=');return [t.slice(0,i),t.slice(i+1)];}));add(tags['display-name']||match[2],match[3]);}if(line.includes(' NOTICE ')&&/Login authentication failed|Improperly formatted auth/.test(line)){disconnect();status('接続失敗','認証エラー');}}};ws.onerror=()=>{if(socket===ws)status('接続エラー','通信環境を確認してください');};ws.onclose=()=>{clearTimeout(timer);if(socket===ws){socket=null;status('切断されました','接続設定から再接続してください');}};};
function clock(){$('clock').textContent=new Date().toLocaleString('ja-JP',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}clock();setInterval(clock,30000);
for(const sample of samples)add(...sample);select(messages[0]);
window.addEventListener('beforeunload',()=>{stop();socket?.close();});
