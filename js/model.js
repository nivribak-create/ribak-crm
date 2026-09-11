// Pipeline definition: the six stages, in order, and every negative outcome
// that can take a lead out of it.

export const STAGES = [
  { id: 'new',        label: 'ליד חדש',            short: 'חדש',         done: 'ליד חדש נכנס',        action: null },
  { id: 'whatsapp',   label: 'קיבל הודעת וואטסאפ', short: 'וואטסאפ',     done: 'נשלחה הודעת וואטסאפ', action: 'וואטסאפ נשלח' },
  { id: 'call',       label: 'קיבל שיחה ראשונה',   short: 'שיחה ראשונה', done: 'בוצעה שיחה ראשונה',   action: 'שיחה ראשונה' },
  { id: 'followup',   label: 'פולואפ',             short: 'פולואפ',      done: 'בוצע פולואפ',         action: 'פולואפ בוצע' },
  { id: 'trial',      label: 'סגר שבוע ניסיון',    short: 'שבוע ניסיון', done: 'נסגר שבוע ניסיון',    action: 'סגר ניסיון' },
  { id: 'subscribed', label: 'סגר מנוי',           short: 'מנוי',        done: 'נסגר מנוי',           action: 'סגר מנוי' },
];

export const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));
export const stageIndex = id => STAGES.findIndex(s => s.id === id);
export const nextStage = id => STAGES[stageIndex(id) + 1] || null;
export const FINAL_STAGE = STAGES[STAGES.length - 1].id;

// Each reason is the "negative" of a step. `from` lists the stages a lead can
// be standing on when this reason applies, so the lost dialog can put the
// relevant ones first.
export const LOST_REASONS = [
  { id: 'invalid',        label: 'מספר לא תקין',                    from: ['new'] },
  { id: 'irrelevant',     label: 'ליד כפול / לא רלוונטי',           from: ['new', 'whatsapp'] },
  { id: 'wa_no_reply',    label: 'לא הגיב להודעת הוואטסאפ',         from: ['whatsapp'] },
  { id: 'call_no_answer', label: 'לא ענה לשיחה הראשונה',            from: ['new', 'whatsapp'] },
  { id: 'call_not_int',   label: 'לא מעוניין אחרי השיחה הראשונה',   from: ['call'] },
  { id: 'fu_no_answer',   label: 'לא ענה לפולואפ',                  from: ['call'] },
  { id: 'fu_not_int',     label: 'לא מעוניין אחרי הפולואפ',         from: ['followup'] },
  { id: 'trial_no_close', label: 'לא סגר שבוע ניסיון',              from: ['followup'] },
  { id: 'trial_no_show',  label: 'לא הגיע לשבוע הניסיון',           from: ['trial'] },
  { id: 'trial_cancel',   label: 'ביטל את שבוע הניסיון',            from: ['trial'] },
  { id: 'sub_no_close',   label: 'לא סגר מנוי אחרי הניסיון',       from: ['trial'] },
  { id: 'fit',            label: 'לא מתאים – מחיר / מיקום / שעות',  from: ['call', 'followup', 'trial'] },
  { id: 'other',          label: 'סיבה אחרת',                        from: [] },
];

export const REASON_BY_ID = Object.fromEntries(LOST_REASONS.map(r => [r.id, r]));
export const reasonLabel = id => (REASON_BY_ID[id] || REASON_BY_ID.other).label;

export const SOURCES = ['אינסטגרם', 'פייסבוק', 'גוגל', 'המלצה', 'אתר אינטרנט', 'הגיע למקום', 'אחר'];

export const STATUS = {
  active: { id: 'active', label: 'בטיפול' },
  won:    { id: 'won',    label: 'סגר מנוי' },
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
};
