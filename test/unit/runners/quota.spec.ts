import { describe, expect, it, vi } from 'vitest';

import {
  formatGpuQuota,
  formatQuota,
  quotaCheck,
  quotaKinds,
  readQuota,
  readQuotas,
  readQuotaStatus,
  skippedRegions,
  startsNoRunners,
  type QuotaLimits,
} from '../../../src/runners/quota.js';

const one = (region: string, limits: QuotaLimits) =>
  new Map([[region, limits]]);

describe('quota check', () => {
  it("reads the region's spot vCPU quota", () => {
    const check = quotaCheck(
      'aws',
      ['us-east-2'],
      one('us-east-2', { spot: 100, onDemand: 2048 }),
      true,
    );
    expect(check).toMatchObject({ vcpus: 100 });
    expect(check.problem).toBeUndefined();
    expect(check.increase).toContain('L-34B43A08) in us-east-2');
    expect(formatQuota(check, true)).toBe(
      '100 spot vCPUs (25 backmesh-4 jobs at once)',
    );
  });

  it.each([
    [{ spot: 3 }, /allows 3 spot vCPUs, under one 4-vCPU VM/],
    [{}, /azure reported no lowPriorityCores limit in westus2/],
    [{ spot: NaN }, /no lowPriorityCores limit/],
  ])('refuses a quota under one backmesh-4 VM or unread', (limits, problem) => {
    expect(
      quotaCheck('azure', ['westus2'], one('westus2', limits), true).problem,
    ).toMatch(problem);
  });

  it('reads the on-demand quota for the on-demand classes', () => {
    expect(
      quotaCheck(
        'aws',
        ['us-east-2'],
        one('us-east-2', { spot: 2048, onDemand: 64 }),
        false,
      ),
    ).toMatchObject({
      vcpus: 64,
      increase: expect.stringContaining('L-1216C47A) in us-east-2'),
    });
    expect(
      quotaCheck('gcp', ['us-central1'], new Map(), false).increase,
    ).toMatch(/"CPUS", "N2D_CPUS"/);
  });

  it('names the quotas to raise on GCP, whose quotas are not read', () => {
    const check = quotaCheck('gcp', ['us-central1'], new Map(), true);
    expect(check).toEqual({
      increase: expect.stringMatching(
        /CPUS_ALL_REGIONS.*PREEMPTIBLE_CPUS.*N2D_CPUS.*N2_CPUS/,
      ),
    });
    expect(formatQuota(check, true)).toMatch(/^spot vCPUs unread \(raise/);
  });

  it("sums the regions' limits and names the unread ones", () => {
    const limits = new Map<string, QuotaLimits>([
      ['us-east-2', { spot: 64 }],
      ['us-west-2', { spot: 32 }],
      ['us-east-1', {}],
    ]);
    const check = quotaCheck(
      'aws',
      ['us-east-2', 'us-west-2', 'us-east-1'],
      limits,
      true,
    );
    expect(check).toMatchObject({ vcpus: 96, unread: ['us-east-1'] });
    expect(check.increase).toContain('in us-east-2, us-west-2, us-east-1');
    expect(formatQuota(check, true)).toBe(
      '96 spot vCPUs (24 backmesh-4 jobs at once, unread in us-east-1)',
    );
  });
});

describe('GPU quota', () => {
  const GPU = [
    { label: 'backmesh-gpu-t4', vcpus: 4, spot: true, gpu: 'T4' },
    { label: 'backmesh-gpu-od-t4', vcpus: 4, spot: false, gpu: 'T4' },
  ];

  it("counts a GPU runner against its family's quota, and Azure's spot ones against low-priority vCPUs", () => {
    expect(quotaKinds('aws', true)).toEqual(['spot']);
    expect(quotaKinds('aws', true, 'T4')).toEqual(['gpuSpot']);
    expect(quotaKinds('aws', false, 'T4')).toEqual(['gpuOnDemand']);
    expect(quotaKinds('azure', true, 'T4')).toEqual(['spot']);
    expect(quotaKinds('azure', false, 'T4')).toEqual([
      'gpuOnDemand',
      'onDemand',
    ]);
  });

  it("names the GPU labels a new account's 0 quota starts no runners for, and which quota to raise", () => {
    const limits = new Map<string, QuotaLimits>([
      ['us-east-1', { spot: 640, onDemand: 128, gpuSpot: 0, gpuOnDemand: 8 }],
      ['us-east-2', { spot: 640, onDemand: 128, gpuSpot: 0, gpuOnDemand: 0 }],
    ]);
    const classes = GPU.map((c) => ({
      ...c,
      regions: ['us-east-1', 'us-east-2'],
    }));
    expect(startsNoRunners('aws', limits, classes)).toEqual([
      "backmesh-gpu-t4 would start no runners: every runner region's GPU spot quota is under one 4-vCPU runner (us-east-1 0 vCPU, us-east-2 0 vCPU); raise L-3819A6DF in us-east-1 or us-east-2 to use it.",
    ]);
    expect(skippedRegions('aws', limits, classes)).toEqual([
      'us-east-1: GPU spot quota 0 vCPU, skipped; raise L-3819A6DF to use it',
      'us-east-2: GPU spot quota 0 vCPU, skipped; raise L-3819A6DF to use it',
      'us-east-2: GPU on-demand quota 0 vCPU, skipped; raise L-DB2E81BA to use it',
    ]);
    expect(formatGpuQuota('aws', ['us-east-1', 'us-east-2'], limits)).toBe(
      'GPU quota: 0 spot vCPUs (0 backmesh-gpu-t4 jobs at once), 8 on-demand vCPUs (2 backmesh-gpu-od-t4 jobs at once); raise EC2 "All G and VT Spot Instance Requests" (L-3819A6DF) in us-east-1, us-east-2 to run backmesh-gpu-t4',
    );
  });

  it("checks Azure's on-demand GPU runners against the T4 family and the regional vCPUs both", () => {
    const azure = (limits: QuotaLimits) =>
      startsNoRunners(
        'azure',
        new Map([['eastus', limits]]),
        GPU.map((c) => ({ ...c, regions: ['eastus'] })),
      );
    expect(azure({ spot: 100, onDemand: 100, gpuOnDemand: 0 })).toEqual([
      expect.stringMatching(
        /^backmesh-gpu-od-t4 would start no runners: .*GPU on-demand quota .*raise "Standard NCASv3_T4 Family vCPUs" in eastus/,
      ),
    ]);
    expect(azure({ spot: 100, onDemand: 2, gpuOnDemand: 8 })).toEqual([
      expect.stringMatching(/^backmesh-gpu-od-t4 .*"Total Regional vCPUs"/),
    ]);
    expect(azure({ spot: 2, onDemand: 100, gpuOnDemand: 8 })).toEqual([
      expect.stringMatching(
        /^backmesh-gpu-t4 .*"Total Regional Low-priority vCPUs"/,
      ),
    ]);
    expect(formatGpuQuota('azure', ['eastus'], new Map([['eastus', {}]]))).toBe(
      'GPU quota: on-demand vCPUs unread, and its spot VMs count against the spot vCPUs above; raise "Standard NCASv3_T4 Family vCPUs" in eastus to run backmesh-gpu-od-t4',
    );
  });

  it('leaves the GPU quotas unread when only their read fails', async () => {
    const command = vi.fn(async (args: string[]) => {
      if (args.includes('L-3819A6DF')) throw new Error('NoSuchResource');
      return '64\n';
    });
    expect(await readQuota('aws', 'us-east-2', command)).toEqual({
      spot: 64,
      onDemand: 64,
      gpuSpot: undefined,
      gpuOnDemand: 64,
    });
  });
});

describe('quota read through the cloud CLI', () => {
  it("reads AWS's standard and G and VT Service Quotas codes in the region", async () => {
    const command = vi.fn(async (args: string[]) =>
      args.includes('L-34B43A08') ? '640.0\n' : '128.0\n',
    );
    expect(await readQuota('aws', 'us-east-2', command)).toEqual({
      spot: 640,
      onDemand: 128,
      gpuSpot: 128,
      gpuOnDemand: 128,
    });
    expect(command.mock.calls.map(([args]) => args.join(' '))).toEqual(
      ['L-34B43A08', 'L-1216C47A', 'L-3819A6DF', 'L-DB2E81BA'].map(
        (code) =>
          `aws service-quotas get-service-quota --service-code ec2 --quota-code ${code} --region us-east-2 --query Quota.Value --output text`,
      ),
    );
  });

  it("reads Azure's regional compute usage, whatever its case", async () => {
    const command = vi.fn(async () =>
      JSON.stringify([
        { name: { value: 'standardDSv5Family' }, limit: 10 },
        { name: { value: 'LowPriorityCores' }, limit: '3' },
        { name: { value: 'cores' }, limit: 350 },
        { name: { value: 'standardNCASv3_T4Family' }, limit: 0 },
      ]),
    );
    expect(await readQuota('azure', 'westus2', command)).toEqual({
      spot: 3,
      onDemand: 350,
      gpuOnDemand: 0,
    });
    expect(command.mock.calls[0]).toEqual([
      ['az', 'vm', 'list-usage', '--location', 'westus2', '--output', 'json'],
    ]);
  });

  it("runs nothing for GCP and passes a CLI's failure on", async () => {
    const command = vi.fn(async (): Promise<string> => {
      throw new Error('AccessDeniedException');
    });
    expect(await readQuota('gcp', 'us-central1', command)).toEqual({});
    expect(command).not.toHaveBeenCalled();
    await expect(readQuota('aws', 'us-east-2', command)).rejects.toThrow(
      'AccessDeniedException',
    );
  });

  it('leaves another region unread when its read fails, not the home one', async () => {
    const command = vi.fn(async (args: string[]) => {
      if (args.includes('eu-south-2')) throw new Error('OptInRequired');
      return '64\n';
    });
    const read = (region: string) => readQuota('aws', region, command);
    expect(await readQuotas(['us-east-2', 'eu-south-2'], read)).toEqual(
      new Map([
        ['us-east-2', { spot: 64, onDemand: 64, gpuSpot: 64, gpuOnDemand: 64 }],
        ['eu-south-2', {}],
      ]),
    );
    await expect(readQuotas(['eu-south-2', 'us-east-2'], read)).rejects.toThrow(
      'OptInRequired',
    );
  });
});

describe('readQuotaStatus', () => {
  it("reads the control plane's current standard-family spot and on-demand limits", async () => {
    const asked: unknown[] = [];
    const entry = (
      resourceKey: string,
      currentLimit: number,
      region = 'us-east-2',
    ) => ({
      cloud: 'AWS' as const,
      kind: 'current' as const,
      region,
      resourceKey,
      resourceName: resourceKey,
      status: 'CURRENT',
      currentLimit,
    });
    const api = {
      getQuotaStatus: async (input: unknown) => {
        asked.push(input);
        return {
          entries: [
            entry('aws:l-34b43a08', 512),
            entry('aws:l-1216c47a', 256),
            entry('aws:l-3819a6df', 0),
            entry('aws:l-db2e81ba', 16),
            entry('aws:l-34b43a08', 99, 'us-west-2'),
            { ...entry('aws:l-85eed4f7', 7), kind: 'unavailable' as const },
          ],
        };
      },
    } as unknown as Parameters<typeof readQuotaStatus>[0];
    expect(await readQuotaStatus(api, 'aws', 'bm-aws', 'us-east-2')).toEqual({
      spot: 512,
      onDemand: 256,
      gpuSpot: 0,
      gpuOnDemand: 16,
    });
    expect(asked).toEqual([
      {
        query: { cloud: 'AWS', credentialName: 'bm-aws', region: 'us-east-2' },
      },
    ]);
    expect(await readQuotaStatus(api, 'gcp', 'bm-gcp', 'us-central1')).toEqual(
      {},
    );
  });

  // As anycloud reports a limit it couldn't read: its row, or the region's.
  it.each([
    ['the limit', { resourceKey: 'aws:l-1216c47a' }],
    ['the region', {}],
  ])(
    "fails with the control plane's why when %s is unavailable",
    async (_, key) => {
      const api = {
        getQuotaStatus: async () => ({
          entries: [
            {
              cloud: 'AWS',
              kind: 'current',
              region: 'us-east-2',
              resourceKey: 'aws:l-34b43a08',
              resourceName: 'spot',
              status: 'CURRENT',
              currentLimit: 512,
            },
            {
              cloud: 'AWS',
              kind: 'unavailable',
              region: 'us-east-2',
              ...key,
              resourceName: 'on-demand',
              status: 'UNAVAILABLE',
              message: 'AccessDeniedException',
            },
          ],
        }),
      } as unknown as Parameters<typeof readQuotaStatus>[0];
      await expect(
        readQuotaStatus(api, 'aws', 'bm-aws', 'us-east-2'),
      ).rejects.toThrow('AccessDeniedException');
      // The listener's partial read takes the limit that was read.
      expect(
        await readQuotaStatus(api, 'aws', 'bm-aws', 'us-east-2', true),
      ).toEqual({
        spot: 512,
        onDemand: undefined,
        gpuSpot: undefined,
        gpuOnDemand: undefined,
      });
    },
  );

  it("reads Azure's regional low-priority and total vCPUs with its credential", async () => {
    const asked: unknown[] = [];
    const current = (resourceKey: string, currentLimit: number) => ({
      cloud: 'Azure',
      kind: 'current',
      region: 'westus2',
      resourceKey,
      resourceName: resourceKey,
      status: 'CURRENT',
      currentLimit,
    });
    const api = {
      getQuotaStatus: async (input: unknown) => {
        asked.push(input);
        return {
          entries: [
            current('azure:lowprioritycores', 100),
            current('azure:cores', 20),
            current('azure:standardncasv3_t4family', 8),
          ],
        };
      },
    } as unknown as Parameters<typeof readQuotaStatus>[0];
    expect(await readQuotaStatus(api, 'azure', 'bm-azure', 'westus2')).toEqual({
      spot: 100,
      onDemand: 20,
      gpuOnDemand: 8,
    });
    expect(asked).toEqual([
      {
        query: {
          cloud: 'Azure',
          credentialName: 'bm-azure',
          region: 'westus2',
        },
      },
    ]);
  });
});
