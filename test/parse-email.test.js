const { parseEmail, detectAction } = require('../srv/email-listener');

describe('parseEmail', () => {
  test('extracts invoice, item, material, quantity and amount from a typical email', () => {
    const info = parseEmail({
      subject: 'Complaint',
      text: 'Hello team,\nInvoice 90000123 item 20: 5 PC of material ABC-1 arrived broken.\nPlease credit EUR 120.',
      from: 'buyer@customer.com'
    });
    expect(info).toMatchObject({
      invoiceNumber: '90000123',
      invoiceItem: '20',
      material: 'ABC-1',
      quantity: 5,
      unit: 'PC',
      claimedAmount: 120,
      proposedAction: 'RETURN',
      from: 'buyer@customer.com'
    });
  });

  test('reason covers subject and the whole body, not just the first line', () => {
    const info = parseEmail({ subject: 'Leaking drums', text: 'Hello,\n\nThe drums are leaking.' });
    expect(info.reason).toBe('Leaking drums Hello, The drums are leaking.');
  });

  test('reason is truncated to 1000 characters', () => {
    expect(parseEmail({ text: 'x'.repeat(5000) }).reason).toHaveLength(1000);
  });

  test('claimed amount with currency and space ("EUR 50") is found', () => {
    expect(parseEmail({ text: 'We claim EUR 50 for invoice 90000123' }).claimedAmount).toBe(50);
    expect(parseEmail({ text: 'refund of €12,50 please' }).claimedAmount).toBe(12.5);
  });

  test('quantities are not mistaken for claimed amounts', () => {
    const info = parseEmail({ text: 'Please credit 10 PC from invoice 90000123' });
    expect(info.claimedAmount).toBeNull();
    expect(info.quantity).toBe(10);
  });

  test('invoice number is not mistaken for a claimed amount', () => {
    expect(parseEmail({ text: 'credit 90000123 invoice 90000123' }).claimedAmount).toBeNull();
  });

  test('"materials are faulty" does not produce a bogus material number', () => {
    expect(parseEmail({ text: 'The materials are faulty, invoice 90000123' }).material).toBeNull();
  });

  test('"material number: X" and "material #X" both work', () => {
    expect(parseEmail({ text: 'material number: TG11' }).material).toBe('TG11');
    expect(parseEmail({ text: 'material #4711' }).material).toBe('4711');
  });

  test('free-text units are mapped to SAP unit codes', () => {
    expect(parseEmail({ text: '3 pieces damaged' }).unit).toBe('PC');
  });

  test('missing fields come back as null', () => {
    const info = parseEmail({ subject: 'Hi', text: 'Just saying hello' });
    expect(info).toMatchObject({
      invoiceNumber: null, invoiceItem: null, material: null, quantity: null,
      claimedAmount: null, soldToParty: null, proposedAction: null
    });
  });

  test('handles undefined text (HTML-only emails)', () => {
    expect(() => parseEmail({ subject: 'x', text: undefined })).not.toThrow();
  });
});

describe('detectAction', () => {
  test.each([
    ['You overcharged us', 'CREDIT'],
    ['Please send another one', 'REPLACEMENT'],
    ['The goods are defective', 'RETURN'],
    ['Hello there', null]
  ])('%s -> %s', (text, expected) => {
    expect(detectAction(text)).toBe(expected);
  });
});
