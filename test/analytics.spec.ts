import { describe, it, expect } from 'vitest';
import { ProxyExchangeSummary } from '../src/services/analytics';
import { LLMUsage, MODEL_PRICES } from '../src/services/repos/models';

describe('ProxyExchangeSummary', () => {
  describe('estimateCost', () => {
    it('should calculate cost correctly for input tokens only', () => {
      // Use a real model that has only input cost
      // Find a model with only input cost
      const modelName = Object.keys(MODEL_PRICES).find(
        key => MODEL_PRICES[key].input_cost_per_token && !MODEL_PRICES[key].output_cost_per_token
      ) || 'tts-1'; // Fallback to tts-1 which has only input cost
      
      const usage: LLMUsage = {
        model: modelName,
        inputTokens: 1000
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      const expectedCost = 1000 * MODEL_PRICES[modelName.toLowerCase()].input_cost_per_token!;
      expect(cost).toBe(expectedCost);
    });
    
    it('should calculate cost correctly for both input and output tokens', () => {
      // Use a real model that has both input and output costs
      // Find a model with both input and output costs
      const modelName = Object.keys(MODEL_PRICES).find(
        key => MODEL_PRICES[key].input_cost_per_token && MODEL_PRICES[key].output_cost_per_token
      ) || 'gpt-4'; // Fallback to a model that likely has both costs
      
      const usage: LLMUsage = {
        model: modelName,
        inputTokens: 1000,
        outputTokens: 500
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      const modelPricing = MODEL_PRICES[modelName.toLowerCase()];
      const expectedCost = (1000 * modelPricing.input_cost_per_token!) + 
                          (500 * modelPricing.output_cost_per_token!);
      expect(cost).toBe(expectedCost);
    });
    
    it('should handle scientific notation in cost values', () => {
      // Find a model with costs in scientific notation (most models use this format)
      const modelName = Object.keys(MODEL_PRICES).find(
        key => {
          const pricing = MODEL_PRICES[key];
          return pricing.input_cost_per_token && 
                 pricing.output_cost_per_token && 
                 pricing.input_cost_per_token.toString().includes('e-');
        }
      ) || 'ai21.jamba-instruct-v1:0'; // Fallback to a model with scientific notation
      
      const usage: LLMUsage = {
        model: modelName,
        inputTokens: 1000,
        outputTokens: 500
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      const modelPricing = MODEL_PRICES[modelName.toLowerCase()];
      const expectedCost = (1000 * modelPricing.input_cost_per_token!) + 
                          (500 * modelPricing.output_cost_per_token!);
      expect(cost).toBe(expectedCost);
    });
    
    it('should return 0 cost if model is not found', () => {
      const usage: LLMUsage = {
        model: 'non-existent-model',
        inputTokens: 1000
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      expect(cost).toBe(0);
    });
    
    it('should handle case-insensitive model names', () => {
      // Find a real model to use
      const modelName = Object.keys(MODEL_PRICES)[0];
      const uppercaseModelName = modelName.toUpperCase();
      
      const usage: LLMUsage = {
        model: uppercaseModelName,
        inputTokens: 1000
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      const modelPricing = MODEL_PRICES[modelName.toLowerCase()];
      let expectedCost = 0;
      
      if (modelPricing.input_cost_per_token) {
        expectedCost += 1000 * modelPricing.input_cost_per_token;
      }
      
      expect(cost).toBe(expectedCost);
    });
    
    it('should handle missing output tokens', () => {
      // Find a model with both input and output costs
      const modelName = Object.keys(MODEL_PRICES).find(
        key => MODEL_PRICES[key].input_cost_per_token && MODEL_PRICES[key].output_cost_per_token
      ) || 'gpt-4';
      
      const usage: LLMUsage = {
        model: modelName,
        inputTokens: 1000
        // No outputTokens
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      const expectedCost = 1000 * MODEL_PRICES[modelName.toLowerCase()].input_cost_per_token!;
      expect(cost).toBe(expectedCost);
    });

    it('should handle missing input cost', () => {
      // Try to find a model with only output cost
      const modelName = Object.keys(MODEL_PRICES).find(
        key => !MODEL_PRICES[key].input_cost_per_token && MODEL_PRICES[key].output_cost_per_token
      );
      
      // If we can't find a real model with only output cost, we'll skip this test
      if (!modelName) {
        console.log('Skipping test: No model found with only output cost');
        return;
      }
      
      const usage: LLMUsage = {
        model: modelName,
        inputTokens: 1000,
        outputTokens: 500
      };
      
      const cost = ProxyExchangeSummary.estimateCost(usage);
      const expectedCost = 500 * MODEL_PRICES[modelName.toLowerCase()].output_cost_per_token!;
      expect(cost).toBe(expectedCost);
    });

    it('should return 0 when model summary is not found', () => {
      // Create a usage object with a model name that doesn't exist in MODEL_PRICES
      const usage: LLMUsage = {
        model: 'non-existent-model-' + Date.now(), // Ensure uniqueness
        inputTokens: 1000,
        outputTokens: 500
      };
      
      // Call estimateCost with the usage object
      const cost = ProxyExchangeSummary.estimateCost(usage);
      
      // Verify that the cost is 0 when the model is not found
      expect(cost).toBe(0);
    });
  });
}); 