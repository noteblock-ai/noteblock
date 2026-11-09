import { LIMITS } from "./constants.js";

export const BOT_NAMES = ["Nova", "Pip", "Juno", "Rook", "Kit", "Mara", "Ash", "Vale", "Wren", "Bix", "Orla", "Tamsin", "Fenn", "Quill", "Sable", "Ivo"];

const ADJ = ["Swift", "Brave", "Lucky", "Sunny", "Mellow", "Zippy", "Plucky", "Bouncy", "Breezy", "Cosmic", "Jolly", "Nimble", "Rusty", "Sly", "Tidy", "Witty"];
const NOUN = ["Otter", "Comet", "Falcon", "Pebble", "Badger", "Maple", "Rocket", "Puffin", "Ember", "Lynx", "Gecko", "Marlin", "Raven", "Sprout", "Taco", "Yeti"];

export function randomName(rnd = Math.random): string {
  return ADJ[Math.floor(rnd() * ADJ.length)] + NOUN[Math.floor(rnd() * NOUN.length)];
}

// A short blocklist; matched against the name with separators and digit substitutions removed.
const BLOCK = [
  "fuck", "shit", "cunt", "bitch", "nigg", "fag", "rape", "nazi", "hitler", "slut", "whore", "dick", "cock", "pussy", "penis", "vagina",
  "retard", "kike", "spic", "chink", "twat", "wank", "porn", "sex", "anal", "cum", "jizz", "tits", "boob", "kkk", "isis", "pedo",
];

function normalize(s: string) {
  return s.toLowerCase().replace(/[\s_\-]/g, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t").replace(/\$/g, "s").replace(/@/g, "a");
}

/** Returns a clean nickname, or a random one if the input is unusable. */
export function sanitizeName(input: unknown, rnd = Math.random): string {
  if (typeof input !== "string") return randomName(rnd);
  let s = input.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nameMax);
  if (s.length < LIMITS.nameMin) return randomName(rnd);
  const n = normalize(s);
  if (BLOCK.some((b) => n.includes(b))) return randomName(rnd);
  return s;
}
