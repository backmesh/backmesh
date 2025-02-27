#!/usr/bin/env node
const fs = require('fs');
const https = require('https');

// URL to fetch the prices.json file
const jsonUrl = 'https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json';
const outputFile = 'backmesh/src/services/repos/prices.json';

// Function to fetch JSON data from URL
function fetchJsonFromUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch data: ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
        } catch (error) {
          reject(new Error('Failed to parse JSON data'));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// Main function
async function main() {
  try {
    console.log(`Fetching data from ${jsonUrl}...`);
    const data = await fetchJsonFromUrl(jsonUrl);
    
    // Process each model entry
    const filteredData = {};
    for (const [modelName, modelInfo] of Object.entries(data)) {
      // Create a new object with only input_cost and output_cost fields
      const filteredModelInfo = {};
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.startsWith('input_cost') || key.startsWith('output_cost')) {
          filteredModelInfo[key] = value;
        }
      }
      
      // Only add the model if it has at least one input_cost or output_cost field
      if (Object.keys(filteredModelInfo).length > 0) {
        filteredData[modelName] = filteredModelInfo;
      }
    }
    
    // Create directory if it doesn't exist
    const dir = outputFile.substring(0, outputFile.lastIndexOf('/'));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Write the filtered data to a new file
    fs.writeFileSync(outputFile, JSON.stringify(filteredData, null, 2));
    
    console.log(`Processed ${Object.keys(data).length} model entries.`);
    console.log(`Kept ${Object.keys(filteredData).length} model entries with input_cost or output_cost fields.`);
    console.log(`Filtered data written to ${outputFile}`);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the main function
main();