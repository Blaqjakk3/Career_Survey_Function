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

// Set execution timeout to 25 seconds to avoid 30s limit
const EXECUTION_TIMEOUT = 25000;
const AI_TIMEOUT = 12000; // Reduced to 12 seconds for faster AI analysis

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
        databases.listDocuments('career4me', 'careerPaths', [Query.limit(50)])
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

        const contextPrompt = buildOptimizedContextPrompt(talent, surveyResponses, currentCareerPath);
        const careerPathsSummary = createEnhancedPathSummary(relevantPaths);

        const analysisPrompt = `${contextPrompt}

CAREER PATHS AVAILABLE (${relevantPaths.length}):
${careerPathsSummary}

TASK: Analyze and rank suitable career paths. Return your TOP 6 BEST MATCHES as JSON.

SCORING CRITERIA:
- Skills Alignment (35%): Current skills + learning interest + transferable skills
- Interest Match (25%): Personal interests + field preferences  
- Education Fit (20%): Educational background relevance
- Career Stage Fit (10%): Appropriate for ${talent.careerStage} level
- Growth Potential (10%): Future opportunities

RULES:
1. Score each path 0-100
2. Include mix of perfect fits (85-100%), strong matches (70-84%), growth opportunities (55-69%)
3. Focus on skills AND interests alignment
4. Consider transferable skills

Return this JSON:
{
  "matches": [
    {
      "careerPathId": "path_id_here",
      "matchScore": 92,
      "reasoning": "Brief why this matches (focus on top 2 factors)",
      "strengths": ["2 specific strengths"],
      "developmentAreas": ["2 key development areas"],
      "recommendations": ["3 actionable steps"]
    }
  ]
}`;

        // AI analysis with reduced timeout and optimized thinking
        const aiPromise = ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: analysisPrompt,
            config: {
                thinkingConfig: {
                    thinkingBudget: 512 // Reduced thinking budget for faster response
                }
            }
        });
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT)
        );

        const result = await Promise.race([aiPromise, timeoutPromise]);
        const aiResponse = result.text;
        
        // Clean and parse JSON response
        const cleanResponse = aiResponse.replace(/```json\n?|\n?```/g, '').trim();
        const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
            throw new Error('No valid JSON found in AI response');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        if (!analysisResult.matches || !Array.isArray(analysisResult.matches)) {
            throw new Error('Invalid matches structure in AI response');
        }
        
        // Enrich with full career path data and validate
        const enrichedMatches = analysisResult.matches
            .map(match => {
                const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
                if (!careerPath) return null;
                
                return {
                    careerPath,
                    matchScore: Math.min(Math.max(match.matchScore || 50, 0), 100),
                    reasoning: match.reasoning || `Good fit for ${talent.careerStage} profile`,
                    strengths: Array.isArray(match.strengths) ? match.strengths.slice(0, 3) : ['Strong foundation for growth'],
                    developmentAreas: Array.isArray(match.developmentAreas) ? match.developmentAreas.slice(0, 3) : ['Industry knowledge', 'Specialized skills'],
                    recommendations: Array.isArray(match.recommendations) ? match.recommendations.slice(0, 4) : ['Take relevant courses', 'Build portfolio projects', 'Network with professionals']
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.matchScore - a.matchScore);

        log(`AI generated ${enrichedMatches.length} matches`);
        
        // Ensure we have at least 4 matches
        if (enrichedMatches.length < 4) {
            log(`Only ${enrichedMatches.length} AI matches, supplementing with fallback`);
            const fallbackMatches = generateEnhancedFallbackMatches(surveyResponses, careerPaths, talent);
            
            const existingIds = new Set(enrichedMatches.map(m => m.careerPath.$id));
            const additionalMatches = fallbackMatches.filter(m => !existingIds.has(m.careerPath.$id));
            
            enrichedMatches.push(...additionalMatches.slice(0, 4 - enrichedMatches.length));
        }

        return enrichedMatches.slice(0, 6); // Return top 6 matches

    } catch (err) {
        log(`AI analysis failed (${err.message}), using enhanced fallback`);
        return generateEnhancedFallbackMatches(surveyResponses, careerPaths, talent);
    }
}

function preFilterCareerPaths(surveyResponses, careerPaths) {
    // Enhanced filtering to be more inclusive while still reducing load
    const interestedFields = surveyResponses.interestedFields || [];
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    
    if (interestedFields.length === 0 && currentSkills.length === 0 && interests.length === 0) {
        return careerPaths.slice(0, 25); // Reduced for faster processing
    }

    const filtered = careerPaths.filter(path => {
        let score = 0;
        
        // Field match (high weight)
        if (interestedFields.includes(path.industry)) score += 3;
        
        // Skill overlap (medium-high weight)
        const pathSkills = path.requiredSkills || [];
        const skillMatches = currentSkills.filter(skill => 
            pathSkills.some(pathSkill => 
                pathSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(pathSkill.toLowerCase())
            )
        ).length;
        score += skillMatches;
        
        // Interest alignment (medium weight)
        const pathInterests = path.requiredInterests || [];
        const interestMatches = interests.filter(interest =>
            pathInterests.some(pathInterest =>
                pathInterest.toLowerCase().includes(interest.toLowerCase()) ||
                interest.toLowerCase().includes(pathInterest.toLowerCase())
            )
        ).length;
        score += interestMatches * 0.5;
        
        return score > 0;
    });

    // If we filtered too aggressively, include more paths
    if (filtered.length < 12) {
        const remaining = careerPaths.filter(path => !filtered.includes(path));
        filtered.push(...remaining.slice(0, 12 - filtered.length));
    }

    return filtered.slice(0, 25); // Limit for faster processing
}

function createEnhancedPathSummary(paths) {
    return paths.map(path => {
        const skills = (path.requiredSkills || []).slice(0, 3).join(',');
        const interests = (path.requiredInterests || []).slice(0, 2).join(',');
        return `${path.$id}: "${path.title}" | ${path.industry} | Skills: ${skills} | Interests: ${interests}`;
    }).join('\n');
}

function buildOptimizedContextPrompt(talent, surveyResponses, currentCareerPath) {
    const age = calculateAge(talent.dateofBirth);
    
    let prompt = `PROFILE: ${talent.careerStage}, Age: ${age}, Education: ${surveyResponses.educationLevel || 'Not specified'}`;
    
    if (surveyResponses.degreeProgram) {
        prompt += ` (${surveyResponses.degreeProgram})`;
    }
    
    prompt += `
SKILLS: Current: ${(surveyResponses.currentSkills || []).slice(0, 5).join(', ')}
Learning: ${(surveyResponses.skillsToLearn || []).slice(0, 5).join(', ')}
INTERESTS: ${(surveyResponses.interests || []).slice(0, 5).join(', ')}
FIELDS: ${(surveyResponses.interestedFields || []).join(', ')}`;

    if (surveyResponses.workEnvironmentPreference) {
        prompt += `
WORK PREF: ${surveyResponses.workEnvironmentPreference}`;
    }

    if (currentCareerPath) {
        prompt += `
CURRENT: ${currentCareerPath.title} (${surveyResponses.yearsExperience || '?'} years, ${surveyResponses.currentSeniorityLevel || '?'} level)`;
        
        if (surveyResponses.reasonForChange) {
            prompt += `, Change reason: ${surveyResponses.reasonForChange}`;
        }
    }

    if (surveyResponses.careerGoals) {
        prompt += `
GOALS: ${surveyResponses.careerGoals}`;
    }

    return prompt;
}

function generateEnhancedFallbackMatches(surveyResponses, careerPaths, talent) {
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    const fields = surveyResponses.interestedFields || [];
    const skillsToLearn = surveyResponses.skillsToLearn || [];
    
    const scoredPaths = careerPaths.map(path => {
        let score = 0;
        let reasoning = [];
        
        // Enhanced scoring algorithm
        const skillMatches = (path.requiredSkills || [])
            .filter(skill => currentSkills.some(userSkill => 
                userSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(userSkill.toLowerCase())
            )).length;
        score += skillMatches * 25;
        if (skillMatches > 0) reasoning.push(`${skillMatches} skill match${skillMatches > 1 ? 'es' : ''}`);
        
        const learningMatches = (path.requiredSkills || [])
            .filter(skill => skillsToLearn.some(learnSkill =>
                learnSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(learnSkill.toLowerCase())
            )).length;
        score += learningMatches * 15;
        if (learningMatches > 0) reasoning.push(`eager to learn ${learningMatches} skill${learningMatches > 1 ? 's' : ''}`);
        
        const interestMatches = (path.requiredInterests || [])
            .filter(interest => interests.some(userInterest =>
                userInterest.toLowerCase().includes(interest.toLowerCase()) ||
                interest.toLowerCase().includes(userInterest.toLowerCase())
            )).length;
        score += interestMatches * 20;
        if (interestMatches > 0) reasoning.push(`${interestMatches} interest alignment${interestMatches > 1 ? 's' : ''}`);
        
        if (fields.includes(path.industry)) {
            score += 30;
            reasoning.push(`strong interest in ${path.industry}`);
        }
        
        // Career stage bonus
        if (path.level && talent.careerStage) {
            if ((talent.careerStage === 'Pathfinder' && path.level === 'Entry') ||
                (talent.careerStage === 'Trailblazer' && ['Entry', 'Mid'].includes(path.level)) ||
                (talent.careerStage === 'Horizon Changer' && ['Mid', 'Senior'].includes(path.level))) {
                score += 10;
                reasoning.push(`fits ${talent.careerStage} level`);
            }
        }
        
        // Add variety
        score += Math.random() * 5;
        
        return {
            careerPath: path,
            matchScore: Math.min(Math.round(score), 90), // Cap at 90 for fallback
            reasoning: reasoning.length > 0 ? reasoning.join(', ') : `Potential fit for ${talent.careerStage}`,
            strengths: currentSkills.slice(0, 2).concat(['Growth mindset']),
            developmentAreas: ['Industry knowledge', 'Specialized skills'],
            recommendations: [
                'Research the field',
                'Take relevant courses',
                'Network with professionals',
                'Build relevant projects'
            ]
        };
    });
    
    return scoredPaths
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 6);
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