// Narrow compatibility patch for the pinned upstream migration's device-99 JID.
import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../node_modules/@whiskeysockets/baileys/',import.meta.url);
const pkg=JSON.parse(readFileSync(new URL('package.json',root),'utf8'));
if(pkg.version!=='7.0.0-rc14') throw Error('Review hosted migration patch before changing Baileys version');
const file=new URL('lib/Signal/libsignal.js',root);
const old='const lidWithDevice = transferDevice(jid, toJid);';
const fixed="const lidWithDevice = transferDevice(jid, isHostedPnUser(jid) ? `${jidDecode(toJid).user}@hosted.lid` : toJid);";
const source=readFileSync(file,'utf8');
if(source.includes(fixed)) process.exit(0);
if(source.split(old).length!==2) throw Error('Upstream migration changed; refusing ambiguous patch');
writeFileSync(file,source.replace(old,fixed));
console.log('Applied pinned hosted-device migration compatibility patch');
