// Pipeline definition: the six stages a Ribak lead really passes through,
// and every negative outcome that can take it out of the pipeline.
//
// The rhythm behind these stages: orders close Wednesday 23:00, food is
// delivered Sunday morning, and the subscription call happens Tuesday —
// so a lead that closes after Wednesday night waits a full extra week.

export const STAGES = [
  { id: 'new',        label: 'ליד חדש',              short: 'חדש',      done: 'ליד חדש נכנס',       action: null },
  { id: 'contacted',  label: 'נוצר קשר',             short: 'נוצר קשר', done: 'נוצר קשר',           action: 'שלחתי הודעה' },
  { id: 'pitched',    label: 'בוצעה שיחת מכירה',     short: 'שיחת מכירה', done: 'בוצעה שיחת מכירה', action: 'ביצעתי שיחת מכירה' },
  { id: 'trial',      label: 'סגר שבוע ניסיון',      short: 'ניסיון',   done: 'נסגר שבוע ניסיון',   action: 'סגר שבוע ניסיון' },
  { id: 'delivered',  label: 'קיבל את המשלוח',       short: 'קיבל אוכל', done: 'קיבל את המשלוח',    action: 'קיבל את המשלוח' },
  { id: 'subscribed', label: 'מנוי פעיל',            short: 'מנוי',     done: 'נסגר מנוי',          action: 'סגר מנוי' },
];

export const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));
export const stageIndex = id => STAGES.findIndex(s => s.id === id);
export const nextStage = id => STAGES[stageIndex(id) + 1] || null;
export const FINAL_STAGE = STAGES[STAGES.length - 1].id;

// Stage ids used before the pipeline was rebuilt around the real flow.
// Follow-up was demoted from a stage to an action, so those leads land on
// the sales call they had already been through.
export const LEGACY_STAGES = { whatsapp: 'contacted', call: 'pitched', followup: 'pitched' };

// Each reason is the "negative" of a step. `from` lists the stages a lead
// can be standing on when the reason applies, so the lost dialog shows the
// relevant ones first. The wording comes from what customers actually say.
export const LOST_REASONS = [
  { id: 'no_answer',     label: 'לא ענה אחרי כמה ניסיונות',      from: ['new', 'contacted', 'pitched', 'trial', 'delivered'] },
  { id: 'invalid',       label: 'מספר לא תקין',                  from: ['new', 'contacted'] },
  { id: 'irrelevant',    label: 'לא רלוונטי / ליד כפול',         from: ['new', 'contacted'] },
  { id: 'out_of_area',   label: 'מחוץ לאזור החלוקה',             from: ['new', 'contacted', 'pitched'] },
  { id: 'price',         label: 'יקר לי',                        from: ['pitched', 'delivered'] },
  { id: 'thinking',      label: 'אמר שיחשוב ולא חזר',            from: ['pitched'] },
  { id: 'delivery_time', label: 'זמני המשלוח לא מתאימים',        from: ['pitched'] },
  { id: 'food_type',     label: 'סוג האוכל לא מתאים לו',         from: ['pitched'] },
  { id: 'taste',         label: 'לא אהב את הטעם',                from: ['delivered'] },
  { id: 'variety',       label: 'מגוון קטן מדי',                 from: ['delivered'] },
  { id: 'no_need',       label: 'אין לו צורך',                   from: ['delivered'] },
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
  active: { id: 'active', label: 'בטיפול' },
  won:    { id: 'won',    label: 'מנוי פעיל' },
  lost:   { id: 'lost',   label: 'אבד' },
};

export const EVENT_LABELS = {
  created:  'ליד נכנס למערכת',
  advanced: 'התקדם לשלב',
  lost:     'סומן כאבוד',
  restored: 'הוחזר לפייפליין',
  attempt:  'ניסיון ללא מענה',
  note:     'הערה',
  edited:   'פרטים עודכנו',
  imported: 'יובא מרשימה',
};
