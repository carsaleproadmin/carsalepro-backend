import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreatePpvDto } from './create-ppv.dto';

/*
 * The endpoint that takes money for a report refused every report code the
 * mobile app has written for the last year: the rule here was the sequential
 * form alone. On the page it looked like a button that does nothing, because a
 * 400 from a server action is silent.
 */
describe('CreatePpvDto', () => {
  const errors = (reportCode: unknown) =>
    validateSync(plainToInstance(CreatePpvDto, { reportCode }));

  it('accepts the code format reports are written with', () => {
    expect(errors('CSP-179932ec-2a51-4b3f-9a7e-2b3c4d5e6f70')).toHaveLength(0);
  });

  it('still accepts the legacy sequential code', () => {
    expect(errors('CSP-042')).toHaveLength(0);
  });

  it('refuses anything that is not a report code', () => {
    expect(errors('CSP-demo-golf').length).toBeGreaterThan(0);
    expect(errors('179932ec-2a51-4b3f-9a7e-2b3c4d5e6f70').length).toBeGreaterThan(0);
    expect(errors('').length).toBeGreaterThan(0);
    expect(errors(42).length).toBeGreaterThan(0);
  });
});
