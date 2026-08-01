// @vitest-environment happy-dom

/**
 * La nota sul subworkflow.
 *
 * Deve comparire quando serve — cioè quando qualcuno ha chiesto di aspettare
 * e crede che aspetterà — e sparire quando non serve: un avviso che c'è
 * sempre si impara a non leggere.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SubworkflowNote } from './SubworkflowNote';

afterEach(cleanup);

describe('la nota sul subworkflow', () => {
  it('compare quando si è chiesto di aspettare', () => {
    render(<SubworkflowNote config={{ wait: 'true' }} />);
    expect(screen.getByText(/non aspetta ancora/)).toBeTruthy();
  });

  it('compare anche senza il campo: aspettare è il valore predefinito', () => {
    render(<SubworkflowNote config={{}} />);
    expect(screen.getByText(/non aspetta ancora/)).toBeTruthy();
  });

  it('non compare a chi ha scelto di non aspettare: sa già cosa succede', () => {
    const { container } = render(<SubworkflowNote config={{ wait: 'false' }} />);
    expect(container.textContent).toBe('');
  });
});
