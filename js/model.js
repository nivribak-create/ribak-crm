// Pipeline definition: the six stages a Ribak lead really passes through,
// and every negative outcome that can take it out of the pipeline.
//
// The rhythm behind these stages: orders close Wednesday 23:00, food is
// delivered Sunday morning, and the subscription call happens Tuesday —
// so a lead that closes after Wednesday night waits a full extra week.

export const STAGES = [
  { id: 'new',        label: 'ליד חדש',              short: 'חדש',      done: 'ליד חדש נכנס',       action: null },
  { id: 'followup',   label: 'פולואפ – עדיין לא קיבל שיחה', short: 'פולואפ', done: 'עבר לפולואפ',    action: 'לא הצלחתי לתפוס' },
  { id: 'pitched',    label: 'בוצעה שיחת מכירה',     short: 'שיחת מכירה', done: 'בוצעה שיחת מכירה', action: 'ביצעתי שיחת מכירה' },
  { id: 'trial',      label: 'סגר שבוע ניסיון',      short: 'ניסיון',   done: 'נסגר שבוע ניסיון',   action: 'סגר שבוע ניסיון' },
  { id: 'delivered',  label: 'קיבל את המשלוח',       short: 'קיבל אוכל', done: 'קיבל את המשלוח',    action: 'קיבל את המשלוח' },
  { id: 'repeat',     label: 'הזמין שבוע נוסף',      short: 'שבוע נוסף', done: 'הזמין שבוע נוסף',   action: 'הזמין שבוע נוסף' },
  { id: 'subscribed', label: 'מנוי פעיל',            short: 'מנוי',     done: 'נסגר מנוי',          action: 'סגר מנוי' },
];

export const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));
export const stageIndex = id => STAGES.findIndex(s => s.id === id);
export const nextStage = id => STAGES[stageIndex(id) + 1] || null;
export const FINAL_STAGE = STAGES[STAGES.length - 1].id;

// Stage ids used before the pipeline was rebuilt around the real flow.
// Follow-up was demoted from a stage to an action, so those leads land on
// the sales call they had already been through.
// 'whatsapp' and 'contacted' both meant contact had been attempted without
// a sales call happening — which is what follow-up now means.
export const LEGACY_STAGES = { whatsapp: 'followup', contacted: 'followup', call: 'pitched' };

// Each reason is the "negative" of a step. `from` lists the stages a lead
// can be standing on when the reason applies, so the lost dialog shows the
// relevant ones first. The wording comes from what customers actually say.
export const LOST_REASONS = [
  { id: 'no_answer',     label: 'לא ענה אחרי כמה ניסיונות',      from: ['new', 'followup', 'pitched', 'trial', 'delivered', 'repeat'] },
  { id: 'invalid',       label: 'מספר לא תקין',                  from: ['new', 'followup'] },
  { id: 'irrelevant',    label: 'לא רלוונטי / ליד כפול',         from: ['new', 'followup'] },
  { id: 'out_of_area',   label: 'מחוץ לאזור החלוקה',             from: ['new', 'followup', 'pitched'] },
  { id: 'price',         label: 'יקר לי',                        from: ['pitched', 'delivered', 'repeat', 'subscribed'] },
  { id: 'thinking',      label: 'אמר שיחשוב ולא חזר',            from: ['pitched'] },
  { id: 'delivery_time', label: 'זמני המשלוח לא מתאימים',        from: ['pitched'] },
  { id: 'food_type',     label: 'סוג האוכל לא מתאים לו',         from: ['pitched'] },
  { id: 'taste',         label: 'לא אהב את הטעם',                from: ['delivered', 'repeat', 'subscribed'] },
  { id: 'variety',       label: 'מגוון קטן מדי',                 from: ['delivered', 'repeat', 'subscribed'] },
  { id: 'no_need',       label: 'אין לו צורך',                   from: ['delivered', 'repeat', 'subscribed'] },
  { id: 'paused',        label: 'הפסקה זמנית / חופשה',           from: ['repeat', 'subscribed'] },
  { id: 'other',         label: 'סיבה אחרת',                     from: [] },
];

export const REASON_BY_ID = Object.fromEntries(LOST_REASONS.map(r => [r.id, r]));
export const reasonLabel = id => (REASON_BY_ID[id] || REASON_BY_ID.other).label;

// Reasons that mean "never really entered the funnel" — they say nothing
// about how well the selling works, so the funnel report sets them aside.
export const DISQUALIFYING = new Set(['invalid', 'irrelevant', 'out_of_area']);

export const LEGACY_REASONS = {
  wa_no_reply: 'no_answer', call_no_answer: 'no_answer', fu_no_answer: 'no_answer',
  call_not_int: 'thinking', fu_not_int: 'thinking', trial_no_close: 'price',
  trial_no_show: 'no_answer', trial_cancel: 'no_need', sub_no_close: 'price', fit: 'price',
};

// Both Instagram routes are tracked apart: paid is spend you control,
// influencers are waves of exposure you only partly control.
export const SOURCES = [
  'אינסטגרם – ממומן',
  'אינסטגרם – משפיען',
  'המלצה',
  'אתר',
  'וואטסאפ',
  'אחר',
  'לא ידוע',
];
export const INFLUENCER_SOURCE = 'אינסטגרם – משפיען';
export const UNKNOWN_SOURCE = 'לא ידוע';

export const LEGACY_SOURCES = {
  'אינסטגרם': 'אינסטגרם – ממומן',
  'פייסבוק': 'אחר',
  'גוגל': 'אחר',
  'אתר אינטרנט': 'אתר',
  'הגיע למקום': 'אחר',
};

export const STATUS = {
  active:  { id: 'active',  label: 'בטיפול' },
  won:     { id: 'won',     label: 'מנוי פעיל' },
  churned: { id: 'churned', label: 'היה מנוי והפסיק' },
  lost:    { id: 'lost',    label: 'אבד' },
};
export const STATUSES = Object.keys(STATUS);

// A lead that reached "subscribed" was sold successfully even if the
// subscription later stopped — selling and retention are different
// questions, and the funnel must not confuse them.
export const everSubscribed = l => l.status === 'won' || l.status === 'churned';

// The outcome groups the pipeline can't express on its own: they cut across
// stage and status to answer "what actually became of this customer".
export const OUTCOMES = [
  { id: 'open',        label: 'עדיין בטיפול',              test: l => l.status === 'active' },
  { id: 'subscriber',  label: 'מנוי פעיל',                 test: l => l.status === 'won' },
  { id: 'churned',     label: 'היה מנוי והפסיק',           test: l => l.status === 'churned' },
  { id: 'repeat_only', label: 'הזמין שוב אבל בלי מנוי',    test: l => l.stage === 'repeat' && l.status === 'lost' },
  { id: 'trial_only',  label: 'ניסה שבוע ולא המשיך',       test: l => ['trial', 'delivered'].includes(l.stage) && l.status === 'lost' },
  { id: 'never_paid',  label: 'אבד לפני שבוע הניסיון',     test: l => ['new', 'followup', 'pitched'].includes(l.stage) && l.status === 'lost' },
];
export const OUTCOME_BY_ID = Object.fromEntries(OUTCOMES.map(o => [o.id, o]));
export const outcomeOf = l => OUTCOMES.find(o => o.test(l))?.id || 'open';

// Influencer partnerships run their own little pipeline, separate from the
// customer one: who we want to work with, who we already approached, and
// who is actually sending people.
export const INFLUENCER_STATUSES = [
  { id: 'wishlist', label: 'רוצה לפנות',        short: 'רוצה לפנות' },
  { id: 'reached',  label: 'פניתי, אין תשובה',  short: 'פניתי' },
  { id: 'talking',  label: 'בשיחות',            short: 'בשיחות' },
  { id: 'active',   label: 'שיתוף פעולה פעיל',  short: 'פעיל' },
  { id: 'done',     label: 'הסתיים',            short: 'הסתיים' },
  { id: 'rejected', label: 'לא יצא לפועל',      short: 'לא יצא' },
];
export const INFLUENCER_STATUS_BY_ID = Object.fromEntries(INFLUENCER_STATUSES.map(s => [s.id, s]));

// Some contacts were never customers — a collaboration was discussed and
// somebody wrote that next to the name.
export const COLLAB_RE = /שת["'׳״]?פ|שיתוף\s*פעולה|משפיע|קולאב|collab|influencer|ambassador|ברטר/i;
export const looksLikeCollab = l => COLLAB_RE.test(`${l.name} ${l.notes}`);

// A first guess at an Instagram handle, from whatever name we have.
export const handleFrom = name => String(name || '')
  .replace(COLLAB_RE, '')
  .replace(/[^\p{L}\p{N}_.]+/gu, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 30)
  .toLowerCase();

export const EVENT_LABELS = {
  created:  'ליד נכנס למערכת',
  advanced: 'התקדם לשלב',
  lost:     'סומן כאבוד',
  restored: 'הוחזר לפייפליין',
  churned:  'המנוי הופסק',
  attempt:  'ניסיון ללא מענה',
  note:     'הערה',
  edited:   'פרטים עודכנו',
  imported: 'יובא מרשימה',
  script:   'תסריט שיחה',
};
