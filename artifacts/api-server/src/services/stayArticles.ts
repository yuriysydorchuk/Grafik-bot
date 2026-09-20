// Підстава karta pobytu czasowego — стаття ustawy o cudzoziemcach з decyzji (рішення власника
// 20.09.2026: «мета» вибирається статтею, бо карта може бути по возз'єднанню, захисту тощо, а на
// самій карті мета не друкується). Довідник «яка стаття що дає»: мета (purpose) виводиться зі
// статті, grantsWork — чи дає право працювати без okремого zezwolenia (ustawa o promocji
// zatrudnienia art. 87 ust. 1–2 + rozporządzenie o zwolnieniach). null = залежить від справи —
// орієнтуємось на анотацію «dostęp do rynku pracy» на звороті карти. verified=false — стаття
// в довіднику є, але наслідок для праці треба підтвердити з юристом (движок трактує як null).
// Дзеркало — web/src/lib/stayArticles.ts (побайтово той самий масив).
export type StayPurpose = "work" | "study" | "family" | "business" | "other";
export interface StayArticle {
  code: string;            // attrs.article у worker_documents
  label: string;           // як у decyzji (PL)
  purpose: StayPurpose;    // → attrs.purpose (мета перебування)
  grantsWork: boolean | null; // право працювати без zezwolenia: true / false / null=за анотацією карти
  employerBound: boolean;  // праця лише у роботодавця з decyzji (114/126/127/139a)
  verified: boolean;       // наслідок для праці підтверджено
  note: string;            // підказка офісу (uk)
}

export const STAY_ARTICLES: StayArticle[] = [
  { code: "art_114", label: "art. 114 — praca (zezwolenie jednolite na pobyt czasowy i pracę)", purpose: "work", grantsWork: true, employerBound: true, verified: true, note: "Праця лише в роботодавця й на умовах з decyzji; інший роботодавець = zmiana zezwolenia або нова decyzja." },
  { code: "art_126", label: "art. 126 — Niebieska Karta UE (wysokie kwalifikacje)", purpose: "work", grantsWork: true, employerBound: true, verified: true, note: "Праця в роботодавця з decyzji; перші 2 роки зміна роботодавця — за згодою wojewody." },
  { code: "art_127", label: "art. 127 — praca w ramach oddelegowania (pracownik delegowany)", purpose: "work", grantsWork: true, employerBound: true, verified: true, note: "Праця лише в межах делегування з decyzji." },
  { code: "art_139a", label: "art. 139a — przeniesienie wewnątrz przedsiębiorstwa (ICT)", purpose: "work", grantsWork: true, employerBound: true, verified: true, note: "Праця лише в jednostce przyjmującej з decyzji." },
  { code: "art_142", label: "art. 142 — prowadzenie działalności gospodarczej", purpose: "business", grantsWork: false, employerBound: false, verified: true, note: "Дає лише бізнес. Праця у нас — потрібне zezwolenie na pracę / oświadczenie (або анотація «dostęp do rynku pracy»)." },
  { code: "art_144", label: "art. 144 — studia stacjonarne", purpose: "study", grantsWork: true, employerBound: false, verified: true, note: "Студент стаціонару звільнений від zezwolenia (art. 87 ust. 2 pkt 1). Тримай чинне zaświadczenie студента." },
  { code: "art_151", label: "art. 151 — prowadzenie badań naukowych", purpose: "other", grantsWork: true, employerBound: false, verified: true, note: "Науковець — праця без zezwolenia в межах досліджень; поза ними — за анотацією." },
  { code: "art_158", label: "art. 158 — członek rodziny obywatela RP", purpose: "family", grantsWork: true, employerBound: false, verified: true, note: "Подружжя/родина громадянина PL — праця без zezwolenia." },
  { code: "art_159", label: "art. 159 — połączenie z rodziną (członek rodziny cudzoziemca)", purpose: "family", grantsWork: true, employerBound: false, verified: true, note: "Возз'єднання сім'ї — праця без zezwolenia (art. 87 ust. 1 pkt 11 ustawy o promocji zatrudnienia)." },
  { code: "art_160", label: "art. 160 — inne okoliczności (pobyt krótkotrwały)", purpose: "other", grantsWork: null, employerBound: false, verified: false, note: "Право на працю залежить від справи — дивись анотацію «dostęp do rynku pracy»; підтвердити з юристом." },
  { code: "art_161", label: "art. 161 — inne okoliczności (kontynuacja pobytu)", purpose: "other", grantsWork: null, employerBound: false, verified: false, note: "Право на працю залежить від справи — дивись анотацію на звороті; підтвердити з юристом." },
  { code: "art_176", label: "art. 176 — ofiara handlu ludźmi", purpose: "other", grantsWork: true, employerBound: false, verified: false, note: "Зазвичай праця без zezwolenia (art. 87 ust. 1 pkt 6) — підтвердити з юристом." },
  { code: "art_186_1_3", label: "art. 186 ust. 1 pkt 3 — absolwent polskiej uczelni (poszukiwanie pracy)", purpose: "other", grantsWork: true, employerBound: false, verified: true, note: "Абсольвент стаціонару польського вишу — праця без zezwolenia (art. 87 ust. 2 pkt 2)." },
  { code: "art_186_1_4", label: "art. 186 ust. 1 pkt 4 — mobilność / dalszy pobyt po innych zezwoleniach", purpose: "other", grantsWork: null, employerBound: false, verified: false, note: "Залежить від попередньої підстави — дивись анотацію; підтвердити з юристом." },
  { code: "art_187", label: "art. 187 — inne okoliczności (np. staż, wolontariat, pobyt z dzieckiem)", purpose: "other", grantsWork: null, employerBound: false, verified: false, note: "Право на працю залежить від пункту decyzji — дивись анотацію; підтвердити з юристом." },
];

export const STAY_ARTICLE_CODES = STAY_ARTICLES.map(a => a.code);
export const stayArticleOf = (code: unknown): StayArticle | null => (typeof code === "string" ? STAY_ARTICLES.find(a => a.code === code) ?? null : null);
/** true/false — довідник знає; null — невідомо або не підтверджено (беремо анотацію карти) */
export const articleGrantsWork = (code: unknown): boolean | null => { const a = stayArticleOf(code); return a && a.verified ? a.grantsWork : null; };
