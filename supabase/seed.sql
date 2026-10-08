-- Optional seed: the 5 demo categories (sheet CATEGORIAS of the public demo
-- workbook fixtures/tralyn-demo.xlsx; fictional data).
-- Idempotent and identical to the workbook, so the importer reports them as
-- already present. Runs on local `supabase db reset`; it is NOT applied by
-- `supabase db push`.
insert into public.categories (name, prefix, description) values
  ('Solar Panels',          'PAN', 'Photovoltaic modules'),
  ('Inverters',             'INV', 'Hybrid and string inverters'),
  ('Batteries',             'BAT', 'Energy storage'),
  ('EV Chargers',           'EVC', null),
  ('Mounting & Protection', 'MNT', 'Mounting structures and electrical protection')
on conflict do nothing;
