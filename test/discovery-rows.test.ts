import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { readRow } from '../src/modules/discovery/index.js';
import { resetDb, teardownDb } from './helpers.js';

describe('reading a pasted row', () => {
  it('picks the columns by name when the header is pasted above the row', () => {
    const reading = readRow(
      'ID\tProduct Name\tCategory\tPrice\tStatus\n' + '1042\tDiesel fuel 20L\tFuel\t45.00 SAR\tActive',
    );
    expect(reading).toEqual({
      product: 'Diesel fuel 20L',
      category: 'Fuel',
      cells: ['1042', 'Diesel fuel 20L', 'Fuel', '45.00 SAR', 'Active'],
      header: ['ID', 'Product Name', 'Category', 'Price', 'Status'],
      productIndex: 1,
      categoryIndex: 2,
    });
  });

  it('reads Arabic column names', () => {
    const reading = readRow('الرقم\tاسم المنتج\tالفئة\tالسعر\n7\tديزل\tوقود\t٤٥ ر.س');
    expect(reading).toMatchObject({ product: 'ديزل', category: 'وقود', productIndex: 1 });
  });

  it('guesses from a lone row: the longest name, then the next name', () => {
    const reading = readRow('SKU-10442\tتوريد الديزل للمصانع\tمحروقات\t1,250.00\tنشط\t2026-10-01');
    expect(reading).toMatchObject({
      product: 'توريد الديزل للمصانع',
      category: 'محروقات',
      header: null,
      productIndex: 1,
      categoryIndex: 2,
    });
  });

  it('skips ids, prices, dates, links, emails and statuses', () => {
    const reading = readRow('10442 | https://shop.example.com/p/1 | sales@example.com | Active | LPG cylinder 12kg | SAR 45');
    expect(reading).toMatchObject({ product: 'LPG cylinder 12kg', category: null, productIndex: 4 });
  });

  it('takes a typed product as it is', () => {
    expect(readRow('  diesel  ')).toMatchObject({ product: 'diesel', cells: ['diesel'], category: null });
    expect(readRow('Diesel, 20L')).toMatchObject({ product: 'Diesel, 20L' });
  });

  it('splits a comma row of three or more cells', () => {
    expect(readRow('1042,Diesel fuel,Fuel,45')).toMatchObject({ product: 'Diesel fuel', category: 'Fuel' });
  });

  it('guesses from the row when the named column is empty', () => {
    const reading = readRow('ID\tName\tDescription\n9\t\tGas oil for generators');
    expect(reading).toMatchObject({ product: 'Gas oil for generators', productIndex: 2 });
    expect(reading!.header).toEqual(['ID', 'Name', 'Description']);
  });

  it('finds nothing in a row with no name in it', () => {
    expect(readRow('10442\t45.00\t2026-10-01\tActive')).toBeNull();
    expect(readRow('  \n ')).toBeNull();
  });

  it('clips a long product to 200 characters', () => {
    expect(readRow('x'.repeat(300))!.product).toHaveLength(200);
  });
});

describe('POST /internal/discovery/read-row', () => {
  const app = createApp();
  const read = (body: unknown, token: string | null = process.env.INTERNAL_TOKEN!) =>
    app.fetch(
      new Request('http://engine.test/internal/discovery/read-row', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Internal-Token': token } : {}) },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(resetDb);
  afterAll(teardownDb);

  it('returns the reading', async () => {
    const res = await read({ row: '1042\tDiesel fuel\tFuel\t45.00' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ product: 'Diesel fuel', category: 'Fuel' });
  });

  it('says so when nothing reads as a product, and refuses without the token', async () => {
    const none = await read({ row: '1042\t45.00' });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'no_product' });

    expect((await read({})).status).toBe(400);
    expect((await read({ row: 'diesel' }, null)).status).toBe(401);
  });
});
