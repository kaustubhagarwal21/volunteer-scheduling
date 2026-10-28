import { useState, type FormEvent } from 'react';
import { formatDuration } from '../lib/format';
import { Button, Field, Input } from './ui';

export interface ShiftFormValues {
  date: string;
  startTime: string;
  durationMinutes: number;
  location: string;
  requiredHeadcount: number;
}

/** Create and edit share one form. The server validates everything again. */
export function ShiftForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
}: {
  initial: ShiftFormValues;
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: ShiftFormValues) => void;
}) {
  const [values, setValues] = useState(initial);
  const set = <K extends keyof ShiftFormValues>(key: K, value: ShiftFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(values);
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Date">
        <Input type="date" required value={values.date} onChange={(e) => set('date', e.target.value)} />
      </Field>
      <Field label="Start time">
        <Input type="time" required value={values.startTime} onChange={(e) => set('startTime', e.target.value)} />
      </Field>
      <Field label="Duration (minutes)" hint={`${formatDuration(values.durationMinutes || 0)} long`}>
        <Input
          type="number"
          required
          min={15}
          max={1440}
          step={15}
          value={values.durationMinutes}
          onChange={(e) => set('durationMinutes', Number(e.target.value))}
        />
      </Field>
      <Field label="Volunteers needed">
        <Input
          type="number"
          required
          min={1}
          max={500}
          value={values.requiredHeadcount}
          onChange={(e) => set('requiredHeadcount', Number(e.target.value))}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Location">
          <Input required maxLength={200} value={values.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" busy={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
