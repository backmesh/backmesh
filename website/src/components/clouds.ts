// The mono cloud marks (simple-icons, currentColor), for inline SVG.
import aws from '../assets/clouds/aws.svg?raw';
import azure from '../assets/clouds/azure.svg?raw';
import gcp from '../assets/clouds/gcp.svg?raw';

export const clouds = [
  { key: 'aws', name: 'AWS', svg: aws },
  { key: 'gcp', name: 'Google Cloud', svg: gcp },
  { key: 'azure', name: 'Azure', svg: azure },
];

/** A mark placed inside another SVG at (x, y), `size` units square. */
export const placeMark = (svg: string, x: number, y: number, size: number) =>
  svg.replace(
    '<svg ',
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" `,
  );
