// FILE PATH: lib/wdSerial.js
// Every withdrawal gets a running number: #01, #02 ... #99, #100 ... (one atomic counter, 1 tiny write per request).
// Shown to the admin, in the payment-proof channel and to the user, so you can count payouts per week / month.
export const wdNo = (w) => (w && w.serial ? `#${String(w.serial).padStart(2, '0')}` : '');

export async function nextWithdrawSerial(db) {
  const r = await db.collection('botSettings').findOneAndUpdate(
    { _id: 'withdrawSerial' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return (r?.value || r)?.seq || null;
}
