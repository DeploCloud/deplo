export type HostInfo = {
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  osPretty: string;
  kernel: string;
  arch: string;
  dockerVersion: string;
  dockerRootDir: string;
  uptimeSec: number;
  timezone: string;
  timeUnixMs: number;
  controlPlaneTimeUnixMs: number;
  utcOffsetMinutes: number;
  canRestartControlPlane: boolean;
};

export const HOST_INFO_FIELDS = `
  cpuModel cpuCores cpuThreads memTotalBytes diskTotalBytes diskUsedBytes
  osPretty kernel arch dockerVersion dockerRootDir uptimeSec
  timezone timeUnixMs controlPlaneTimeUnixMs utcOffsetMinutes
  canRestartControlPlane
`;

// Reading is a host reading, paired with the local instant it arrived.
export type Reading = { info: HostInfo; readAt: number };
