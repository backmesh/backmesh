import { describe, expect, it } from 'vitest';

import { parseLabels } from '../../../test/e2e/labels.ts';

describe('parseLabels', () => {
  it('parses one plain label', () => {
    expect(parseLabels('backmesh-4=aws:us-east-2')).toEqual([
      { label: 'backmesh-4', cloud: 'aws', regions: ['us-east-2'], kvm: false },
    ]);
  });

  it('parses several regions and several entries, space-separated', () => {
    expect(
      parseLabels(
        'backmesh-4=aws:us-east-2,us-east-1,us-west-2 backmesh-gcp-4=gcp:us-central1',
      ),
    ).toEqual([
      {
        label: 'backmesh-4',
        cloud: 'aws',
        regions: ['us-east-2', 'us-east-1', 'us-west-2'],
        kvm: false,
      },
      {
        label: 'backmesh-gcp-4',
        cloud: 'gcp',
        regions: ['us-central1'],
        kvm: false,
      },
    ]);
  });

  it('tolerates extra whitespace, including newlines', () => {
    expect(parseLabels('  backmesh-4=aws:us-east-2\n\n')).toEqual([
      { label: 'backmesh-4', cloud: 'aws', regions: ['us-east-2'], kvm: false },
    ]);
  });

  it('marks a label naming -kvm- as a KVM label', () => {
    expect(parseLabels('backmesh-kvm-4=aws:us-east-2')[0]?.kvm).toBe(true);
    expect(parseLabels('backmesh-aws-kvm-od-4=aws:us-east-2')[0]?.kvm).toBe(
      true,
    );
  });

  it('refuses an empty spec', () => {
    expect(() => parseLabels('')).toThrow('empty');
    expect(() => parseLabels('   ')).toThrow('empty');
  });

  it('refuses an entry with no cloud:region', () => {
    expect(() => parseLabels('backmesh-4')).toThrow(
      "backmesh-4 isn't label=cloud:region",
    );
  });

  it('refuses an entry naming an unknown cloud', () => {
    expect(() => parseLabels('backmesh-4=oracle:us-east-2')).toThrow(
      'names cloud oracle',
    );
  });

  it('refuses an entry with no region', () => {
    expect(() => parseLabels('backmesh-4=aws:')).toThrow('names no region');
  });

  it('refuses a label with unexpected characters', () => {
    expect(() => parseLabels('backmesh_4=aws:us-east-2')).toThrow(
      'unexpected characters',
    );
  });

  it('refuses a label listed twice', () => {
    expect(() =>
      parseLabels('backmesh-4=aws:us-east-2 backmesh-4=aws:us-west-2'),
    ).toThrow('listed more than once');
  });
});
