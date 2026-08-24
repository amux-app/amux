import { describe, expect, it } from 'vitest';
import { BoundedCache } from '../../src/main/services/boundedCache';

describe('BoundedCache', () => {
  it('drops the least recently inserted entry once the bound is exceeded', () => {
    // Arrange
    const cache = new BoundedCache<string>(2);

    // Act
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    // Assert
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('keeps a re-read entry and evicts the untouched one instead', () => {
    // Arrange
    const cache = new BoundedCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');

    // Act
    cache.get('a');
    cache.set('c', '3');

    // Assert
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
  });

  it('overwrites a key without growing the cache', () => {
    // Arrange
    const cache = new BoundedCache<string>(2);

    // Act
    cache.set('a', '1');
    cache.set('a', '2');

    // Assert
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe('2');
  });

  it('hands back and removes an entry on take', () => {
    // Arrange
    const cache = new BoundedCache<string>(2);
    cache.set('a', '1');

    // Act
    const taken = cache.take('a');

    // Assert
    expect(taken).toBe('1');
    expect(cache.size).toBe(0);
    expect(cache.take('a')).toBeUndefined();
  });
});
