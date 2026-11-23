import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPath } from './paths.js';

export const journeyPrefix = '/sendproof/journeys/';

export function registerJourneys(files: readonly (string | URL)[]) {
  interface ArazzoDocument {
    arazzo: string;
    info: { title: string };
    sourceDescriptions: { url: string }[];
  }
  const entries = new Map<string, { arazzo: ArazzoDocument; expectations: unknown }>();
  for (const file of files) {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    const name = basename(path).match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\.arazzo\.json$/)?.[1];
    if (!name || entries.has(name)) throw new TypeError('Journey files need unique <name>.arazzo.json filenames.');
    const arazzo: ArazzoDocument = JSON.parse(readFileSync(path, 'utf8'));
    if (arazzo?.arazzo !== '1.1.0' || typeof arazzo.info?.title !== 'string' || !arazzo.info.title.trim()
        || !Array.isArray(arazzo.sourceDescriptions) || arazzo.sourceDescriptions.some(source => typeof source?.url !== 'string')) {
      throw new TypeError('Journey files need an Arazzo 1.1.0 title and source descriptions.');
    }
    const expectations = JSON.parse(readFileSync(path.replace(/\.arazzo\.json$/, '.expect.json'), 'utf8'));
    if (expectations?.sendproofExpectations !== '1.0' || expectations.arazzo !== name + '.arazzo.json') {
      throw new TypeError('Journey expectations must name the paired Arazzo file and use version 1.0.');
    }
    entries.set(name, { arazzo, expectations });
  }

  return {
    discover(basePath: string) {
      return Array.from(entries, ([name, { arazzo }]) => ({
        name: arazzo.info.title,
        source: 'file',
        arazzoUrl: basePath + journeyPrefix + name + '.arazzo.json',
        expectationsUrl: basePath + journeyPrefix + name + '.expect.json',
      }));
    },
    document(path: string, basePath: string) {
      const route = path.slice(journeyPrefix.length).match(/^([^/]+)\.(arazzo|expect)\.json$/);
      const entry = route && entries.get(route[1]);
      if (!entry) return undefined;
      if (route[2] === 'expect') return entry.expectations;
      const { arazzo } = entry;
      return {
        ...arazzo,
        sourceDescriptions: arazzo.sourceDescriptions.map(source => ({
          ...source, url: localPath(source.url) ? basePath + source.url : source.url,
        })),
      };
    },
  };
}
