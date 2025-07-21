import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// Set execution timeout to 25 seconds to avoid 30s limit
const EXECUTION_TIMEOUT = 25000;
const AI_TIMEOUT = 15000; // 15 seconds for AI analysis

export default async ({ req, res, log, error }) => {
    const startTime = Date.now();
    
    try {
        log('Starting optimized AI career matching...');
        
        const { talentId, surveyResponses } = JSON.parse(req.body);

        if (!talentId || !surveyResponses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId and surveyResponses' 
            }, 400);
        }

        // Set up timeout for entire execution
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Function execution timeout')), EXECUTION_TIMEOUT);
        });

        const executionPromise = executeCareerMatching(talentId, surveyResponses, log, error);
        
        // Race between execution and timeout
        const result = await Promise.race([executionPromise, timeoutPromise]);
        
        const executionTime = Date.now() - startTime;
        log(`Total execution time: ${executionTime}ms`);
        
        return res.json(result);

    } catch (err) {
        const executionTime = Date.now() - startTime;
        error(`Career matching failed after ${executionTime}ms:`, err);
        
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches',
            executionTime: executionTime,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

async function executeCareerMatching(talentId, surveyResponses, log, error) {
    // Fetch talent and career paths in parallel
    const [talentQuery, careerPathsQuery] = await Promise.all([
        databases.listDocuments('career4me', 'talents', [Query.equal('talentId', talentId)]),
        databases.listDocuments('career4me', 'careerPaths', [Query.limit(50)]) // Reduced from 100
    ]);

    if (careerPathsQuery.documents.length === 0) {
        throw new Error('No career paths available');
    }

    if (talentQuery.documents.length === 0) {
        throw new Error('Talent not found');
    }

    const talent = talentQuery.documents[0];

    // Update talent document (non-blocking)
    const validUpdates = filterValidAttributes(surveyResponses);
    validUpdates.testTaken = true;
    
    // Don't await this - let it run in background
    databases.updateDocument('career4me', 'talents', talent.$id, validUpdates)
        .catch(err => log(`Warning: Failed to update talent: ${err.message}`));

    // Get current career path if available (with timeout)
    let currentCareerPath = null;
    if (surveyResponses.currentPath) {
        try {
            currentCareerPath = await Promise.race([
                databases.getDocument('career4me', 'careerPaths', surveyResponses.currentPath),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
            ]);
        } catch (err) {
            log(`Warning: Could not fetch current career path: ${err.message}`);
        }
    }

    // Generate matches with timeout
    const matches = await generateOptimizedAIMatches(
        talent, surveyResponses, careerPathsQuery.documents, currentCareerPath, log
    );

    return {
        success: true,
        matches: matches,
        totalPaths: careerPathsQuery.documents.length,
        matchedPaths: matches.length
    };
}

async function generateOptimizedAIMatches(talent, surveyResponses, careerPaths, currentCareerPath, log) {
    try {
        // Pre-filter career paths to reduce AI processing load
        const relevantPaths = preFilterCareerPaths(surveyResponses, careerPaths);
        log(`Pre-filtered to ${relevantPaths.length} relevant paths from ${careerPaths.length} total`);

        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.0-flash-exp', // Faster model
            generationConfig: {
                maxOutputTokens: 2048, // Limit response size
                temperature: 0.3, // More focused responses
            }
        });

        const contextPrompt = buildOptimizedContextPrompt(talent, surveyResponses, currentCareerPath);
        const careerPathsSummary = createConcisePathSummary(relevantPaths);

        const analysisPrompt = `${contextPrompt}

CAREER PATHS (${relevantPaths.length}):
${careerPathsSummary}

Analyze and return TOP 3 matches as JSON:
{
  "matches": [
    {
      "careerPathId": "id",
      "matchScore": 85,
      "reasoning": "Brief 1-sentence match explanation",
      "strengths": ["strength1", "strength2"],
      "developmentAreas": ["area1", "area2"],
      "recommendations": ["rec1", "rec2", "rec3"]
    }
  ]
}

Match based on: skills (40%), interests (30%), education (20%), fit (10%).`;

        // AI analysis with timeout
        const aiPromise = model.generateContent(analysisPrompt);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT)
        );

        const result = await Promise.race([aiPromise, timeoutPromise]);
        const aiResponse = result.response.text();
        
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Invalid AI response format');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        // Enrich with full career path data
        const enrichedMatches = analysisResult.matches.map(match => {
            const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
            return careerPath ? {
                careerPath,
                matchScore: match.matchScore,
                reasoning: match.reasoning,
                strengths: match.strengths,
                developmentAreas: match.developmentAreas,
                recommendations: match.recommendations
            } : null;
        }).filter(Boolean);

        log(`AI generated ${enrichedMatches.length} matches`);
        return enrichedMatches.slice(0, 5);

    } catch (err) {
        log(`AI analysis failed (${err.message}), using fallback`);
        return generateFastFallbackMatches(surveyResponses, careerPaths, talent.careerStage);
    }
}

function preFilterCareerPaths(surveyResponses, careerPaths) {
    // Quick filtering to reduce AI processing load
    const interestedFields = surveyResponses.interestedFields || [];
    const currentSkills = surveyResponses.currentSkills || [];
    
    if (interestedFields.length === 0 && currentSkills.length === 0) {
        return careerPaths.slice(0, 20); // Return first 20 if no filters
    }

    const filtered = careerPaths.filter(path => {
        // Field match
        const fieldMatch = interestedFields.length === 0 || 
            interestedFields.includes(path.industry);
        
        // Skill overlap
        const pathSkills = path.requiredSkills || [];
        const skillOverlap = currentSkills.some(skill => 
            pathSkills.some(pathSkill => 
                pathSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(pathSkill.toLowerCase())
            )
        );
        
        return fieldMatch || skillOverlap;
    });

    return filtered.length > 0 ? filtered.slice(0, 25) : careerPaths.slice(0, 15);
}

function createConcisePathSummary(paths) {
    return paths.map(path => 
        `${path.$id}:${path.title}(${path.industry})-Skills:${(path.requiredSkills || []).slice(0, 3).join(',')}`
    ).join('\n');
}

function buildOptimizedContextPrompt(talent, surveyResponses, currentCareerPath) {
    const age = calculateAge(talent.dateofBirth);
    
    let prompt = `USER: ${talent.careerStage}, Age:${age}
Education: ${surveyResponses.educationLevel || 'Unknown'}`;
    
    if (surveyResponses.degreeProgram) prompt += ` - ${surveyResponses.degreeProgram}`;
    
    prompt += `
Skills: ${(surveyResponses.currentSkills || []).join(', ')}
Learning: ${(surveyResponses.skillsToLearn || []).join(', ')}
Interests: ${(surveyResponses.interests || []).join(', ')}
Fields: ${(surveyResponses.interestedFields || []).join(', ')}`;

    if (currentCareerPath) {
        prompt += `
Current: ${currentCareerPath.title} (${surveyResponses.yearsExperience || '?'} yrs, ${surveyResponses.currentSeniorityLevel || '?'} level)`;
    }

    return prompt;
}

function generateFastFallbackMatches(surveyResponses, careerPaths, careerStage) {
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    const fields = surveyResponses.interestedFields || [];
    
    const scoredPaths = careerPaths.map(path => {
        let score = 0;
        
        // Quick scoring algorithm
        const skillMatches = (path.requiredSkills || [])
            .filter(skill => currentSkills.includes(skill)).length;
        score += skillMatches * 20;
        
        const interestMatches = (path.requiredInterests || [])
            .filter(interest => interests.includes(interest)).length;
        score += interestMatches * 15;
        
        if (fields.includes(path.industry)) score += 30;
        
        // Random factor for variety
        score += Math.random() * 10;
        
        return {
            careerPath: path,
            matchScore: Math.min(Math.round(score), 100),
            reasoning: `${skillMatches} skill matches and ${interestMatches} interest alignments`,
            strengths: currentSkills.slice(0, 2).map(s => `Strong in ${s}`),
            developmentAreas: ['Industry knowledge', 'Specialized skills'],
            recommendations: ['Take courses', 'Build projects', 'Network']
        };
    });
    
    return scoredPaths
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 3);
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