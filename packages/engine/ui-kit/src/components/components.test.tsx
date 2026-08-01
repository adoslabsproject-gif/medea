/**
 * Component smoke tests — verify each ui-kit primitive renders without
 * crashing and that key variants emit the right semantic class names.
 *
 * Federico-grade contract: if you add a Button variant, you MUST add a
 * test that asserts its className contains the expected token class.
 * This pins the design-system contract at unit-test level (faster than
 * Playwright visual regression which arrives in Fase 5).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, IconButton } from './Button.js';
import { Card } from './Card.js';
import { Input, Textarea } from './Input.js';
import { Select } from './Select.js';
import { Checkbox } from './Checkbox.js';
import { Badge } from './Badge.js';
import { Alert } from './Alert.js';
import { Modal } from './Modal.js';
import { Dropdown } from './Dropdown.js';
import { Tooltip } from './Tooltip.js';
import { Spinner, Skeleton } from './Spinner.js';

describe('ui-kit smoke', () => {
  it('Button renders all variants with semantic tokens', () => {
    const html = renderToStaticMarkup(
      <>
        <Button variant="primary">Save</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">Hint</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    expect(html).toContain('bg-accent');     // primary
    expect(html).toContain('bg-surface');    // secondary or its hover variant
    expect(html).toContain('bg-danger');     // danger
    expect(html).not.toMatch(/bg-(neutral|zinc|blue|red|gray|slate)-\d+/); // no hardcoded shades
  });

  it('IconButton renders required aria-label', () => {
    const html = renderToStaticMarkup(<IconButton aria-label="Close" icon={<span>×</span>} />);
    expect(html).toContain('aria-label="Close"');
  });

  it('Card with title + actions renders both regions', () => {
    const html = renderToStaticMarkup(
      <Card title="My Card" description="Helpful" actions={<Button>Action</Button>}>
        <p>body</p>
      </Card>,
    );
    expect(html).toContain('My Card');
    expect(html).toContain('Helpful');
    expect(html).toContain('Action');
    expect(html).toContain('body');
  });

  it('Input renders label, help, error state', () => {
    const ok = renderToStaticMarkup(<Input label="Email" help="never share" />);
    expect(ok).toContain('Email');
    expect(ok).toContain('never share');
    const err = renderToStaticMarkup(<Input label="Email" error="Required" />);
    expect(err).toContain('border-danger');
    expect(err).toContain('Required');
  });

  it('Textarea renders', () => {
    const html = renderToStaticMarkup(<Textarea label="Note" />);
    expect(html).toContain('Note');
    expect(html).toContain('<textarea');
  });

  it('Select renders options', () => {
    const html = renderToStaticMarkup(
      <Select label="Country"><option>IT</option><option>FR</option></Select>,
    );
    expect(html).toContain('Country');
    expect(html).toContain('<option>IT</option>');
  });

  it('Checkbox renders label + description', () => {
    const html = renderToStaticMarkup(<Checkbox label="I agree" description="to terms" />);
    expect(html).toContain('I agree');
    expect(html).toContain('to terms');
  });

  it('Badge variants use semantic token classes', () => {
    const html = renderToStaticMarkup(
      <>
        <Badge variant="success" dot>OK</Badge>
        <Badge variant="danger">Failed</Badge>
      </>,
    );
    expect(html).toContain('bg-success');
    expect(html).toContain('bg-danger');
  });

  it('Alert renders title + body with dismiss button', () => {
    let dismissed = false;
    const html = renderToStaticMarkup(
      <Alert variant="warning" title="Watch out" onDismiss={() => { dismissed = true; }}>
        Something happened
      </Alert>,
    );
    expect(html).toContain('Watch out');
    expect(html).toContain('Something happened');
    expect(html).toContain('aria-label="Chiudi"');
    expect(dismissed).toBe(false); // no auto-click
  });

  it('Modal returns null when not open', () => {
    const html = renderToStaticMarkup(<Modal open={false} onClose={() => undefined}>hi</Modal>);
    expect(html).toBe('');
  });

  it('Modal renders content when open', () => {
    const html = renderToStaticMarkup(
      <Modal open onClose={() => undefined} title="Confirm">
        Are you sure?
      </Modal>,
    );
    expect(html).toContain('Confirm');
    expect(html).toContain('Are you sure?');
    expect(html).toContain('aria-modal="true"');
  });

  it('Dropdown renders trigger; items only shown when open', () => {
    const html = renderToStaticMarkup(
      <Dropdown trigger={<span>menu</span>} items={[{ id: 'a', label: 'First' }]} />,
    );
    expect(html).toContain('menu');
    expect(html).not.toContain('First'); // closed by default
  });

  it('Tooltip passes through children when disabled', () => {
    const html = renderToStaticMarkup(
      <Tooltip content="hint" disabled><strong>Hover me</strong></Tooltip>,
    );
    expect(html).toContain('Hover me');
    expect(html).not.toContain('hint');
  });

  it('Spinner has aria-label for screen readers', () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain('aria-label="Loading…"');
    expect(html).toContain('role="status"');
  });

  it('Skeleton renders pulse animation by default', () => {
    const html = renderToStaticMarkup(<Skeleton className="h-4 w-20" />);
    expect(html).toContain('animate-pulse');
  });

  it('Skeleton without animation', () => {
    const html = renderToStaticMarkup(<Skeleton animated={false} className="h-4" />);
    expect(html).not.toContain('animate-pulse');
  });
});
