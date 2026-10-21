import test from "node:test";
import assert from "node:assert/strict";
import { extractMessage } from "../src/messageUtils.js";
const msg = (remoteJid, senderPn, fromMe=false) => ({key:{id:"M",remoteJid,senderPn,fromMe},message:{conversation:"hello"}});
test("only direct inbound LID with valid server PN gains a reply route", () => {
  assert.equal(extractMessage(msg("123@lid","13032617528@s.whatsapp.net")).replyJid,"13032617528@s.whatsapp.net");
  for (const m of [msg("123@lid","123@lid"), msg("123@lid","abc@s.whatsapp.net"), msg("123@g.us","13032617528@s.whatsapp.net"),msg("123@lid","13032617528@s.whatsapp.net",true),msg("13032617528@s.whatsapp.net","19999999999@s.whatsapp.net")]) assert.equal(extractMessage(m).replyJid,null);
});
