import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";

const src = readFileSync("./src/assess/qualificationEvidence.ts", "utf8");
// Extract HEAD_NUM and related by evaluating the functions via dynamic scrape
const prisma = new PrismaClient();

// Pull the regex pieces from source with a small eval harness by importing via tsx after temporarily exporting - instead duplicate logic from file read
const HEAD_NUM_MATCH = src.match(/const HEAD_NUM = ([^;]+);/);
const ROMAN = src.match(/const ROMAN[^;]+;/);
console.log("HEAD_NUM def:", HEAD_NUM_MATCH?.[1]?.slice(0, 200));

// Find seasonHeadingSpan wiring
const idx = src.indexOf("seasonHeading");
console.log("seasonHeading mentions:", [...src.matchAll(/seasonHeading\w*/g)].map((m) => m[0]));
const wire = src.indexOf("durationFromSeasonHeadings");
console.log("durationFromSeasonHeadings idx", wire);
console.log(src.slice(src.indexOf("countDurationUnrounded"), src.indexOf("countDurationUnrounded") + 1200));

const d = await prisma.document.findFirst({ where: { id: "cmw4hff0r001hu52c3fril3wh" }, select: { text: true } });
const text = d!.text!;

// Duplicate heading scan using same patterns as in file
const NUM = HEAD_NUM_MATCH ? eval(HEAD_NUM_MATCH[1]) : null;
