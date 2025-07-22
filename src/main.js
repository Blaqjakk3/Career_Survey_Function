import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenAI } from '@google/genai';

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define which attributes exist in the talents collection
const VALID_TALENT_ATTRIBUTES = [
    'fullname', 'email', 'avatar', 'careerStage', 'dateofBirth', 'talentId',
    'selectedPath', 'degrees', 'certifications', 'skills', 'interests',
    'currentPath', 'testTaken', 'interestedFields', 'savedPaths',
    'currentSeniorityLevel', 'savedJobs'
];

const ARRAY_ATTRIBUTES = [
    'degrees', 'certifications', 'skills', 'interests', 
    'interestedFields', 'savedPaths', 'savedJobs'
];

// CRITICAL: Enable asynchronous execution by returning immediately
export default async ({ req, res, log, error }) => {
    // Immediately return response to enable async execution
    res.json({ 
        success: true, 
        message: 'Career matching started. Processing asynchronously...',
        async: true 
    });

    // Continue processing asynchronously
    processCareerMatchingAsync(req, log, error);
};

// Separate async processing function that doesn't block the response
async function processCareerMatchingAsync(req, log, error) {
    const startTime = Date.now();
    
    try {
        log('Starting async AI career matching...');
        
        // Parse request body
        let talentId, surveyResponses;
        try {
            const body = JSON.parse(req.body);
            talentId = body.talentId;
            surveyResponses = body.surveyResponses;
        } catch (parseError) {
            error('Invalid JSON in request body:', parseError.message);
            return;
        }

        if (!talentId || !surveyResponses) {
            error('Missing required parameters: talentId and surveyResponses');
            return;
        }

        // Execute career matching with optimized flow
        const result = await performOptimizedCareerMatching(talentId, surveyResponses, log, error);
        
        const executionTime = Date.now() - startTime;
        log(`Career matching completed successfully in ${executionTime}ms`);
        log(`Generated ${result.matches.length} career path matches`);

        // Store results in the talent document for client retrieval
        await storeMatchResults(talentId, result, log);

    } catch (err) {
        const executionTime = Date.now() - startTime;
        error(`Career matching failed after ${executionTime}ms:`, err.message);
    }
}

async function performOptimizedCareerMatching(talentId, surveyResponses, log, error) {
    // Step 1: Fetch talent and career paths in parallel (optimized query)
    log('Fetching talent and career paths...');
    const fetchStart = Date.now();
    
    const [talentQuery, careerPathsQuery] = await Promise.all([
        databases.listDocuments('career4me', 'talents', [
            Query.equal('talentId', talentId),
            Query.limit(1)
        ]),
        databases.listDocuments('career4me', 'careerPaths', [
            Query.limit(30) // Reduced from 50 to improve performance
        ])
    ]);

    if (careerPathsQuery.documents.length === 0) {
        throw new Error('No career paths available');
    }

    if (talentQuery.documents.length === 0) {
        throw new Error('Talent not found');
    }

    const talent = talentQuery.documents[0];
    log(`Data fetched in ${Date.now() - fetchStart}ms`);

    // Step 2: Update talent document with survey responses (async - don't wait)
    const validUpdates = filterValidAttributes(surveyResponses);
    validUpdates.testTaken = true;
    
    // Fire and forget update
    databases.updateDocument('career4me', 'talents', talent.$id, validUpdates)
        .catch(err => log(`Warning: Failed to update talent: ${err.message}`));

    // Step 3: Get current career path if needed (with timeout)
    let currentCareerPath = null;
    if (surveyResponses.currentPath) {
        try {
            const pathPromise = databases.getDocument('career4me', 'careerPaths', surveyResponses.currentPath);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Current path fetch timeout')), 3000)
            );
            currentCareerPath = await Promise.race([pathPromise, timeoutPromise]);
        } catch (err) {
            log(`Warning: Could not fetch current career path: ${err.message}`);
        }
    }

    // Step 4: Generate matches with streamlined AI processing
    const matchingStart = Date.now();
    const matches = await generateStreamlinedAIMatches(
        talent, surveyResponses, careerPathsQuery.documents, currentCareerPath, log
    );
    log(`Matching completed in ${Date.now() - matchingStart}ms`);

    return {
        success: true,
        matches: matches.slice(0, 5), // Ensure exactly 5 matches
        totalPaths: careerPathsQuery.documents.length,
        matchedPaths: matches.length
    };
}

async function generateStreamlinedAIMatches(talent, surveyResponses, careerPaths, currentCareerPath, log) {
    try {
        // Smart pre-filtering to reduce AI processing load
        const relevantPaths = intelligentPreFilter(surveyResponses, careerPaths);
        log(`Pre-filtered to ${relevantPaths.length} relevant paths`);

        // Build optimized context
        const contextPrompt = buildStreamlinedContext(talent, surveyResponses, currentCareerPath);
        const pathsSummary = createCompactPathSummary(relevantPaths);

        const analysisPrompt = `${contextPrompt}

CAREER PATHS (${relevantPaths.length}):
${pathsSummary}

TASK: Return exactly 5 best career path matches as JSON.

SCORING: Skills(40%) + Interests(30%) + Education(20%) + Stage Fit(10%)

Return JSON:
{
  "matches": [
    {
      "careerPathId": "path_id",
      "matchScore": 85,
      "reasoning": "Brief match explanation",
      "strengths": ["strength1", "strength2"],
      "developmentAreas": ["area1", "area2"],
      "recommendations": ["rec1", "rec2", "rec3"]
    }
  ]
}`;

        // AI analysis with aggressive timeout
        log('Starting streamlined AI analysis...');
        const aiStart = Date.now();
        
        const aiPromise = ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: analysisPrompt
        }).then(result => result.text);
        
        const aiTimeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI timeout after 25 seconds')), 25000)
        );

        const aiResponse = await Promise.race([aiPromise, aiTimeout]);
        
        log(`AI analysis completed in ${Date.now() - aiStart}ms`);
        
        // Fast JSON parsing
        const cleanResponse = aiResponse.replace(/```json\n?|\n?```/g, '').trim();
        const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
            throw new Error('No valid JSON in AI response');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        // Quick enrichment and validation
        const enrichedMatches = analysisResult.matches
            ?.slice(0, 5) // Take only first 5
            ?.map(match => {
                const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
                if (!careerPath) return null;
                
                return {
                    careerPath,
                    matchScore: Math.max(Math.min(match.matchScore || 50, 100), 0),
                    reasoning: match.reasoning || 'Good potential fit',
                    strengths: (match.strengths || ['Adaptability']).slice(0, 2),
                    developmentAreas: (match.developmentAreas || ['Industry knowledge']).slice(0, 2),
                    recommendations: (match.recommendations || ['Research field', 'Build skills']).slice(0, 3)
                };
            })
            .filter(Boolean) || [];

        // Ensure we have exactly 5 matches
        if (enrichedMatches.length < 5) {
            const fallbackMatches = generateQuickFallback(surveyResponses, careerPaths, talent);
            const existingIds = new Set(enrichedMatches.map(m => m.careerPath.$id));
            const additional = fallbackMatches
                .filter(m => !existingIds.has(m.careerPath.$id))
                .slice(0, 5 - enrichedMatches.length);
            enrichedMatches.push(...additional);
        }

        return enrichedMatches.slice(0, 5);

    } catch (err) {
        log(`AI analysis failed: ${err.message}, using quick fallback`);
        return generateQuickFallback(surveyResponses, careerPaths, talent).slice(0, 5);
    }
}

function intelligentPreFilter(surveyResponses, careerPaths) {
    const interestedFields = surveyResponses.interestedFields || [];
    const currentSkills = surveyResponses.currentSkills || [];
    
    if (interestedFields.length === 0 && currentSkills.length === 0) {
        return careerPaths.slice(0, 20); // Return first 20 if no filters
    }

    const scored = careerPaths.map(path => {
        let score = 0;
        
        // Field match (high priority)
        if (interestedFields.includes(path.industry)) score += 10;
        
        // Skill relevance
        const skillMatches = currentSkills.filter(skill => 
            (path.requiredSkills || []).some(pathSkill => 
                pathSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(pathSkill.toLowerCase())
            )
        ).length;
        score += skillMatches * 2;
        
        return { path, score };
    });

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(item => item.path);
}

function createCompactPathSummary(paths) {
    return paths.map(path => {
        const skills = (path.requiredSkills || []).slice(0, 2).join(',');
        return `${path.$id}: "${path.title}" (${path.industry}) - ${skills}`;
    }).join('\n');
}

function buildStreamlinedContext(talent, surveyResponses, currentCareerPath) {
    const age = calculateAge(talent.dateofBirth);
    
    let context = `PROFILE: ${talent.careerStage}, Age: ${age}
EDUCATION: ${surveyResponses.educationLevel || 'Not specified'}`;
    
    if (surveyResponses.degreeProgram) {
        context += ` (${surveyResponses.degreeProgram})`;
    }
    
    context += `
SKILLS: ${(surveyResponses.currentSkills || []).slice(0, 4).join(', ')}
LEARNING: ${(surveyResponses.skillsToLearn || []).slice(0, 4).join(', ')}
INTERESTS: ${(surveyResponses.interests || []).slice(0, 4).join(', ')}
FIELDS: ${(surveyResponses.interestedFields || []).join(', ')}`;

    if (currentCareerPath) {
        context += `
CURRENT: ${currentCareerPath.title} (${surveyResponses.yearsExperience || '?'} years)`;
    }

    return context;
}

function generateQuickFallback(surveyResponses, careerPaths, talent) {
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    const fields = surveyResponses.interestedFields || [];
    
    return careerPaths.map(path => {
        let score = Math.random() * 20; // Base randomness
        
        // Quick scoring
        if (fields.includes(path.industry)) score += 30;
        
        const skillMatches = (path.requiredSkills || [])
            .filter(skill => currentSkills.some(userSkill => 
                userSkill.toLowerCase().includes(skill.toLowerCase())
            )).length;
        score += skillMatches * 15;
        
        return {
            careerPath: path,
            matchScore: Math.min(Math.round(score), 85),
            reasoning: `Potential fit for ${talent.careerStage}`,
            strengths: ['Adaptability', 'Growth mindset'],
            developmentAreas: ['Industry knowledge', 'Specialized skills'],
            recommendations: ['Research field', 'Build relevant skills', 'Network with professionals']
        };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}

async function storeMatchResults(talentId, result, log) {
    try {
        // Store results in talent document for client retrieval
        await databases.updateDocument('career4me', 'talents', talentId, {
            lastCareerMatches: JSON.stringify(result.matches),
            lastMatchTimestamp: new Date().toISOString()
        });
        log('Match results stored successfully');
    } catch (err) {
        log(`Warning: Failed to store results: ${err.message}`);
    }
}

function filterValidAttributes(surveyResponses) {
    const validUpdates = {};
    
    for (const [key, value] of Object.entries(surveyResponses)) {
        if (VALID_TALENT_ATTRIBUTES.includes(key)) {
            if (ARRAY_ATTRIBUTES.includes(key)) {
                validUpdates[key] = Array.isArray(value) ? value : 
                    (value ? [value] : []);
            } else {
                validUpdates[key] = value;
            }
        }
    }
    
    return validUpdates;
}

function calculateAge(dateOfBirth) {
    if (!dateOfBirth) return '?';
    
    const birth = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    
    return age;
}