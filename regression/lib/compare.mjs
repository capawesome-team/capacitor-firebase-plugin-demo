// Usage: node regression/lib/compare.mjs <file a> <file b>
// Prints every step whose result differs, and steps that exist in only one file.
import { readFileSync } from 'node:fs';

function readSteps(path) {
  const steps = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const separator = line.indexOf(': ');
    if (separator > 0) {
      steps.set(line.substring(0, separator), line.substring(separator + 2));
    }
  }
  return steps;
}

const [pathA, pathB] = process.argv.slice(2);
const stepsA = readSteps(pathA);
const stepsB = readSteps(pathB);
const keys = [...new Set([...stepsA.keys(), ...stepsB.keys()])];
let differenceCount = 0;
for (const key of keys) {
  const valueA = stepsA.get(key);
  const valueB = stepsB.get(key);
  if (valueA !== valueB) {
    differenceCount++;
    console.log(`${key}\n  A: ${valueA ?? '<missing>'}\n  B: ${valueB ?? '<missing>'}`);
  }
}
console.log(`${differenceCount} differences, ${stepsA.size} steps in A, ${stepsB.size} steps in B`);
