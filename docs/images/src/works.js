// The "works with" strips of the hero and the social card: the programming languages the bindings
// cover, each with its mark from ui/lang-icons.js, a quieter line of their frameworks, and the
// interface languages from ui/i18n.js written in their own script, with "+N more" and an RTL marker.
// No flags: flags name countries, not languages.
//
//   <div data-works></div>                 every strip (the hero)
//   <div data-works="compact"></div>       shorter strips that fit the social card's copy column
//
// Loaded as a module, so the frames are rendered from an http origin (tools/readme-shots.mjs serves
// the repository to the browser); the marks and the language list are never copied here.
import { langIcon } from '../../../ui/lang-icons.js';
import { CATALOGUES, LANGUAGES } from '../../../ui/i18n.js';

const esc = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// The bindings' languages, in the README's badge order, with the mark ui/lang-icons.js draws for each.
// Node's mark is the JavaScript one the code picker uses; the bindings are typed for TypeScript too.
const BINDINGS = [
  ['csharp', 'C#', '.NET'], ['javascript', 'TypeScript', 'Node.js'], ['python', 'Python'], ['java', 'Java'], ['kotlin', 'Kotlin'],
  ['go', 'Go'], ['ruby', 'Ruby'], ['php', 'PHP'], ['rust', 'Rust'],
];
const FRAMEWORKS = ['ASP.NET Core', 'Express', 'Fastify', 'Hono', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Spring Boot', 'Ktor',
  'net/http', 'chi', 'Gin', 'Echo', 'Rails', 'Laravel', 'Symfony', 'axum', 'Actix Web'];
const FRAMEWORKS_COMPACT = ['ASP.NET Core', 'Express', 'NestJS', 'FastAPI', 'Django', 'Spring Boot', 'Gin', 'Rails', 'Laravel', 'axum'];

// The interface languages shown by name, by catalogue; the rest are counted in "+N more".
const SPOKEN = ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'zh-Hans', 'ko', 'ar', 'he', 'hi'];
const SPOKEN_COMPACT = ['en', 'de', 'fr', 'es', 'ja', 'zh-Hans', 'ar', 'he', 'hi'];

const byCatalogue = id => LANGUAGES.find(language => language.catalogue === id);

function bindingChips(compact) {
  // Compact chips name the runtime alone (.NET, Node.js); the full ones add it after the language.
  return BINDINGS.map(([mark, name, runtime]) => `<span class="chip lang">${langIcon(mark)}<span>${compact ? esc(runtime ?? name) : `${esc(name)}${runtime ? `<i>${esc(runtime)}</i>` : ''}`}</span></span>`).join('');
}

function spokenChips(shown) {
  // A name can stand for more than one catalogue (Português is pt-BR and pt-PT).
  const covered = new Set(shown.flatMap(id => LANGUAGES.filter(language => language.autonym === byCatalogue(id).autonym).map(language => language.catalogue)));
  const chips = shown.map(id => {
    const language = byCatalogue(id);
    const rtl = language.dir === 'rtl' ? '<b class="rtl" title="Right to left">RTL</b>' : '';
    // The chip stays left to right, so the RTL marker sits after the name like the other chips' text.
    return `<span class="chip spoken"><bdi lang="${esc(language.id)}" dir="${language.dir}">${esc(language.autonym)}</bdi>${rtl}</span>`;
  });
  const more = CATALOGUES.length - covered.size;
  return chips.join('') + (more > 0 ? `<span class="chip more">+${more} more</span>` : '');
}

for (const host of document.querySelectorAll('[data-works]')) {
  const compact = host.dataset.works === 'compact';
  host.classList.add('works-strips');
  host.innerHTML = `
    <div class="strip"><span class="cap">Works with</span><div class="chips">${bindingChips(compact)}</div></div>
    <p class="frameworks">${(compact ? FRAMEWORKS_COMPACT : FRAMEWORKS).map(name => `<b>${esc(name)}</b>`).join('<span aria-hidden="true"> · </span>')}${compact ? ' and more' : ''}</p>
    <div class="strip"><span class="cap">In ${CATALOGUES.length} languages</span><div class="chips">${spokenChips(compact ? SPOKEN_COMPACT : SPOKEN)}</div></div>`;
}
