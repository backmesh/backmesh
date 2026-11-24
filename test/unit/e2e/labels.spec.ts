import { describe, expect, it } from 'vitest';

import { parseLabels } from '../../../test/e2e/labels.ts';

describe('parseLabels', () => {
  it('parses one plain label', () => {
    expect(parseLabels('backmesh-ubuntu-2404-4vcpu=aws:us-east-2')).toEqual([
      {
        label: 'backmesh-ubuntu-2404-4vcpu',
        cloud: 'aws',
        regions: ['us-east-2'],
        kvm: false,
        gpu: false,
      },
    ]);
  });

  it('parses several regions and several entries, space-separated', () => {
    expect(
      parseLabels(
        'backmesh-ubuntu-2404-4vcpu=aws:us-east-2,us-east-1,us-west-2 backmesh-gcp-ubuntu-2404-4vcpu=gcp:us-central1',
      ),
    ).toEqual([
      {
        label: 'backmesh-ubuntu-2404-4vcpu',
        cloud: 'aws',
        regions: ['us-east-2', 'us-east-1', 'us-west-2'],
        kvm: false,
        gpu: false,
      },
      {
        label: 'backmesh-gcp-ubuntu-2404-4vcpu',
        cloud: 'gcp',
        regions: ['us-central1'],
        kvm: false,
        gpu: false,
      },
    ]);
  });

  it('tolerates extra whitespace, including newlines', () => {
    expect(
      parseLabels('  backmesh-ubuntu-2404-4vcpu=aws:us-east-2\n\n'),
    ).toEqual([
      {
        label: 'backmesh-ubuntu-2404-4vcpu',
        cloud: 'aws',
        regions: ['us-east-2'],
        kvm: false,
        gpu: false,
      },
    ]);
  });

  it('marks a label naming -kvm- as a KVM label', () => {
    expect(
      parseLabels('backmesh-ubuntu-2404-kvm-4vcpu=aws:us-east-2')[0]?.kvm,
    ).toBe(true);
    expect(
      parseLabels('backmesh-aws-ubuntu-2404-kvm-od-4vcpu=aws:us-east-2')[0]
        ?.kvm,
    ).toBe(true);
  });

  it('marks a label naming -gpu- as a GPU label', () => {
    expect(
      parseLabels('backmesh-ubuntu-2404-gpu-t4=aws:us-east-2')[0],
    ).toMatchObject({
      kvm: false,
      gpu: true,
    });
    expect(
      parseLabels('backmesh-azure-ubuntu-2404-gpu-od-t4=azure:eastus')[0]?.gpu,
    ).toBe(true);
  });

  it('refuses an empty spec', () => {
    expect(() => parseLabels('')).toThrow('empty');
    expect(() => parseLabels('   ')).toThrow('empty');
  });

  it('refuses an entry with no cloud:region', () => {
    expect(() => parseLabels('backmesh-ubuntu-2404-4vcpu')).toThrow(
      "backmesh-ubuntu-2404-4vcpu isn't label=cloud:region",
    );
  });

  it('refuses an entry naming an unknown cloud', () => {
    expect(() =>
      parseLabels('backmesh-ubuntu-2404-4vcpu=oracle:us-east-2'),
    ).toThrow('names cloud oracle');
  });

  it('refuses an entry with no region', () => {
    expect(() => parseLabels('backmesh-ubuntu-2404-4vcpu=aws:')).toThrow(
      'names no region',
    );
  });

  it('refuses a label with unexpected characters', () => {
    expect(() => parseLabels('backmesh_4=aws:us-east-2')).toThrow(
      'unexpected characters',
    );
  });

  it('refuses a label listed twice', () => {
    expect(() =>
      parseLabels(
        'backmesh-ubuntu-2404-4vcpu=aws:us-east-2 backmesh-ubuntu-2404-4vcpu=aws:us-west-2',
      ),
    ).toThrow('listed more than once');
  });
});
