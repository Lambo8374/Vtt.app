import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, formatElevation, formatGrade, formatPace, formatSpeed } from '../src/core/format';

describe('formatage', () => {
  it('passe des mètres aux kilometres', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(1500)).toBe('1.50 km');
    expect(formatDistance(42195)).toBe('42.2 km');
  });

  it('convertit les m/s en km/h', () => {
    expect(formatSpeed(5)).toBe('18.0 km/h');
    expect(formatSpeed(0)).toBe('0.0 km/h');
  });

  it('affiche les heures seulement au-delà de soixante minutes', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('0:00');
  });

  it('marque l absence d altitude', () => {
    expect(formatElevation(null)).toBe('--');
    expect(formatElevation(1204.6)).toBe('1205 m');
  });

  it('exprime l allure en minutes par kilomètre', () => {
    expect(formatPace(5)).toBe('3:20 /km');
    expect(formatPace(0)).toBe('--');
  });

  it('affiche la pente en pourcentage', () => {
    expect(formatGrade(7.25)).toBe('7.3 %');
  });
});
